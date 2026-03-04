import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { config } from "@/lib/server/config";
import { spawnCommand } from "@/lib/server/commands";
import { sha256File } from "@/lib/server/hash";
import { addArtifact, appendJobEvent, updateJobStatus } from "@/lib/server/job-store";
import { logError, logInfo } from "@/lib/server/logger";
import { dataPaths, safeFileName } from "@/lib/server/paths";
import { PnmStreamParser } from "@/lib/server/pnm-parser";
import { discoverScanners } from "@/lib/server/scanner";
import { isScannerProxyEnabled, readResponseJson, scannerProxyFetch } from "@/lib/server/scanner-proxy";
import { scanEventHub } from "@/lib/server/scan-events";
import type { SseJobEvent } from "@/lib/types/jobs";

interface ScanOptions {
  dpi: number;
  mode: "Color" | "Gray";
  scannerDeviceId?: string;
}

interface ScanRuntimeState {
  activeJobId: string | null;
  processes: Map<string, ReturnType<typeof spawnCommand>>;
  proxyAbortControllers: Map<string, AbortController>;
  canceledJobs: Set<string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __scanRuntimeState: ScanRuntimeState | undefined;
}

const runtimeState =
  global.__scanRuntimeState ??
  ({
    activeJobId: null,
    processes: new Map<string, ReturnType<typeof spawnCommand>>(),
    proxyAbortControllers: new Map<string, AbortController>(),
    canceledJobs: new Set<string>()
  } satisfies ScanRuntimeState);

if (process.env.NODE_ENV !== "production") {
  global.__scanRuntimeState = runtimeState;
}

function publish(jobId: string, event: SseJobEvent) {
  scanEventHub.publish(jobId, event);
}

function parseProgressFromChunk(chunk: string, previousPercent: number) {
  const matches = [...chunk.matchAll(/(\d+(?:\.\d+)?)%/g)];
  if (!matches.length) {
    return previousPercent;
  }
  const value = Number(matches[matches.length - 1][1]);
  if (!Number.isFinite(value)) {
    return previousPercent;
  }
  return Math.max(previousPercent, Math.min(100, Math.round(value)));
}

function summarizeText(input: string, maxChars = 500) {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function summarizeScannerStderr(stderr: string, maxChars = 500) {
  const withoutProgress = stderr.replace(/Progress:\s*\d+(?:\.\d+)?%\s*/g, " ");
  const cleaned = withoutProgress.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  return summarizeText(cleaned, maxChars);
}

async function writeImagePdf(params: { pngPath: string; pdfPath: string; width: number; height: number; dpi: number }) {
  const pngBytes = fs.readFileSync(params.pngPath);
  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedPng(pngBytes);

  const widthPt = (params.width * 72) / params.dpi;
  const heightPt = (params.height * 72) / params.dpi;

  const page = pdf.addPage([widthPt, heightPt]);
  page.drawImage(embedded, {
    x: 0,
    y: 0,
    width: widthPt,
    height: heightPt
  });

  const pdfBytes = await pdf.save();
  fs.writeFileSync(params.pdfPath, pdfBytes);
}

function createScanProcess(deviceId: string, options: ScanOptions) {
  const args = [
    "--device-name",
    deviceId,
    "--format=pnm",
    "--progress",
    "--resolution",
    String(options.dpi),
    "--mode",
    options.mode
  ];

  return spawnCommand("scanimage", args);
}

function asFiniteNumber(value: unknown, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return numberValue;
}

interface ProxyScanHeaderPayload {
  width: number;
  height: number;
  channels: number;
}

interface ProxyScanCompletionPayload {
  sessionId: string;
  width?: number;
  height?: number;
  channels?: number;
  partial?: boolean;
  expectedRows?: number;
  actualRows?: number;
  scannerExitCode?: number | null;
}

function markScanCanceled(jobId: string) {
  updateJobStatus({
    jobId,
    status: "canceled",
    errorMessage: "Scan canceled by user"
  });

  appendJobEvent({
    jobId,
    eventType: "scan_canceled"
  });

  publish(jobId, {
    type: "scan_error",
    payload: { message: "Scan canceled" }
  });
}

async function downloadProxyResult(params: {
  sessionId: string;
  format: "png" | "pdf";
  signal: AbortSignal;
}) {
  const response = await scannerProxyFetch(`/scan/results/${encodeURIComponent(params.sessionId)}?format=${params.format}`, {
    method: "GET",
    headers: {
      Accept: params.format === "png" ? "image/png" : "application/pdf"
    },
    signal: params.signal,
    timeoutMs: config.SCAN_TIMEOUT_MS + 30_000
  });

  if (!response.ok) {
    const payload = await readResponseJson(response);
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `scanner proxy result download failed with status ${response.status}`;
    throw new Error(message);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(new Uint8Array(arrayBuffer));
}

async function startScanJobViaProxy(
  jobId: string,
  options: ScanOptions,
  device: {
    deviceId: string;
    description: string;
  }
) {
  const abortController = new AbortController();
  runtimeState.proxyAbortControllers.set(jobId, abortController);

  try {
    const response = await scannerProxyFetch("/scan/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson"
      },
      body: JSON.stringify({
        dpi: options.dpi,
        mode: options.mode,
        scannerDeviceId: device.deviceId,
        rowChunk: config.SCAN_ROW_CHUNK,
        previewMaxWidth: config.SCAN_PREVIEW_MAX_WIDTH,
        previewMaxHeight: config.SCAN_PREVIEW_MAX_HEIGHT
      }),
      signal: abortController.signal,
      timeoutMs: config.SCAN_TIMEOUT_MS + 30_000
    });

    if (!response.ok) {
      const payload = await readResponseJson(response);
      const message =
        typeof payload.error === "string"
          ? payload.error
          : `scanner proxy scan request failed with status ${response.status}`;
      throw new Error(message);
    }

    if (!response.body) {
      throw new Error("Scanner proxy did not return a streaming body");
    }

    let headerPayload: ProxyScanHeaderPayload | null = null;
    let completionPayload: ProxyScanCompletionPayload | null = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let parsed: { type?: string; payload?: Record<string, unknown> };
      try {
        parsed = JSON.parse(trimmed) as { type?: string; payload?: Record<string, unknown> };
      } catch {
        return;
      }

      const payload = parsed.payload ?? {};

      if (parsed.type === "scan_header") {
        const width = asFiniteNumber(payload.width, 0);
        const height = asFiniteNumber(payload.height, 0);
        const channels = asFiniteNumber(payload.channels, 0);
        headerPayload = {
          width,
          height,
          channels
        };

        publish(jobId, {
          type: "scan_header",
          payload: {
            width,
            height,
            channels,
            dpi: asFiniteNumber(payload.dpi, options.dpi),
            mode: (payload.mode === "Gray" ? "Gray" : "Color") as "Color" | "Gray",
            previewWidth: asFiniteNumber(payload.previewWidth, width),
            previewHeight: asFiniteNumber(payload.previewHeight, height),
            previewRowStride: asFiniteNumber(payload.previewRowStride, 1),
            previewColStride: asFiniteNumber(payload.previewColStride, 1)
          }
        });

        appendJobEvent({
          jobId,
          eventType: "scan_header",
          payload: {
            width,
            height,
            channels,
            dpi: asFiniteNumber(payload.dpi, options.dpi),
            mode: payload.mode === "Gray" ? "Gray" : "Color"
          }
        });
        return;
      }

      if (parsed.type === "scan_rows") {
        publish(jobId, {
          type: "scan_rows",
          payload: {
            startRow: asFiniteNumber(payload.startRow, 0),
            rowCount: asFiniteNumber(payload.rowCount, 0),
            channels: asFiniteNumber(payload.channels, 3),
            width: asFiniteNumber(payload.width, headerPayload?.width ?? 0),
            dataBase64: typeof payload.dataBase64 === "string" ? payload.dataBase64 : ""
          }
        });
        return;
      }

      if (parsed.type === "scan_progress") {
        publish(jobId, {
          type: "scan_progress",
          payload: {
            percent: asFiniteNumber(payload.percent, 0)
          }
        });
        return;
      }

      if (parsed.type === "scan_complete") {
        if (typeof payload.sessionId !== "string" || !payload.sessionId) {
          throw new Error("Scanner proxy did not provide a valid scan result session id");
        }

        completionPayload = {
          sessionId: payload.sessionId,
          width: asFiniteNumber(payload.width, headerPayload?.width ?? 0),
          height: asFiniteNumber(payload.height, headerPayload?.height ?? 0),
          channels: asFiniteNumber(payload.channels, headerPayload?.channels ?? 3),
          partial: Boolean(payload.partial),
          expectedRows: asFiniteNumber(payload.expectedRows, headerPayload?.height ?? 0),
          actualRows: asFiniteNumber(payload.actualRows, asFiniteNumber(payload.height, headerPayload?.height ?? 0)),
          scannerExitCode:
            typeof payload.scannerExitCode === "number" || payload.scannerExitCode === null
              ? (payload.scannerExitCode as number | null)
              : null
        };
        return;
      }

      if (parsed.type === "scan_error") {
        const message = typeof payload.message === "string" ? payload.message : "Scanner proxy scan failed";
        throw new Error(message);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = buffer + decoder.decode();
    if (tail.trim()) {
      handleLine(tail);
    }

    if (runtimeState.canceledJobs.has(jobId)) {
      markScanCanceled(jobId);
      return;
    }

    if (!completionPayload) {
      throw new Error("Scanner proxy scan stream ended without completion event");
    }
    const completion = (completionPayload ?? {}) as ProxyScanCompletionPayload;
    const header = (headerPayload ?? {
      width: 0,
      height: 0,
      channels: 3
    }) as ProxyScanHeaderPayload;

    const [remotePng, remotePdf] = await Promise.all([
      downloadProxyResult({
        sessionId: completion.sessionId,
        format: "png",
        signal: abortController.signal
      }),
      downloadProxyResult({
        sessionId: completion.sessionId,
        format: "pdf",
        signal: abortController.signal
      })
    ]);

    if (runtimeState.canceledJobs.has(jobId)) {
      markScanCanceled(jobId);
      return;
    }

    const baseName = safeFileName(`${jobId}-${crypto.randomUUID()}`);
    const pngPath = path.join(dataPaths.scans, `${baseName}.png`);
    const pdfPath = path.join(dataPaths.scans, `${baseName}.pdf`);

    fs.writeFileSync(pngPath, remotePng);
    fs.writeFileSync(pdfPath, remotePdf);

    addArtifact({
      jobId,
      kind: "scan_png",
      path: pngPath,
      mime: "image/png",
      sizeBytes: fs.statSync(pngPath).size,
      sha256: sha256File(pngPath)
    });

    addArtifact({
      jobId,
      kind: "scan_pdf",
      path: pdfPath,
      mime: "application/pdf",
      sizeBytes: fs.statSync(pdfPath).size,
      sha256: sha256File(pdfPath)
    });

    const output = {
      pngUrl: `/api/scan/jobs/${jobId}/download?format=png`,
      pdfUrl: `/api/scan/jobs/${jobId}/download?format=pdf`,
      partial: Boolean(completion.partial),
      expectedRows: asFiniteNumber(completion.expectedRows, asFiniteNumber(completion.height, header.height)),
      actualRows: asFiniteNumber(completion.actualRows, asFiniteNumber(completion.height, header.height))
    };

    publish(jobId, {
      type: "scan_progress",
      payload: { percent: 100 }
    });

    publish(jobId, {
      type: "scan_complete",
      payload: output
    });

    updateJobStatus({
      jobId,
      status: "completed",
      metaPatch: {
        width: asFiniteNumber(completion.width, header.width),
        height: asFiniteNumber(completion.height, header.height || output.actualRows),
        expectedHeight: output.expectedRows,
        channels: asFiniteNumber(completion.channels, header.channels),
        dpi: options.dpi,
        mode: options.mode,
        scannerExitCode: completion.scannerExitCode ?? null,
        partialScan: Boolean(completion.partial),
        proxySessionId: completion.sessionId,
        output
      }
    });

    appendJobEvent({
      jobId,
      eventType: "scan_completed",
      payload: {
        ...output,
        rows: output.actualRows,
        proxySessionId: completion.sessionId
      }
    });

    logInfo("scan completed via proxy", {
      jobId,
      proxySessionId: completion.sessionId,
      dpi: options.dpi,
      mode: options.mode,
      width: asFiniteNumber(completion.width, header.width),
      height: asFiniteNumber(completion.height, header.height || output.actualRows),
      partialScan: Boolean(completion.partial)
    });
  } catch (error) {
    if (runtimeState.canceledJobs.has(jobId)) {
      markScanCanceled(jobId);
      return;
    }

    throw error;
  }
}

export function isScanRunning() {
  return runtimeState.activeJobId !== null;
}

export async function startScanJob(jobId: string, options: ScanOptions) {
  if (runtimeState.activeJobId) {
    throw new Error("A scan job is already active");
  }

  runtimeState.activeJobId = jobId;
  updateJobStatus({
    jobId,
    status: "running",
    metaPatch: {
      dpi: options.dpi,
      mode: options.mode
    }
  });

  appendJobEvent({
    jobId,
    eventType: "scan_started",
    payload: {
      dpi: options.dpi,
      mode: options.mode,
      scannerDeviceId: options.scannerDeviceId ?? null
    }
  });

  try {
    const scanners = await discoverScanners();
    if (!scanners.length) {
      throw new Error("No scanner devices discovered by scanimage -L");
    }

    const requestedScannerId = options.scannerDeviceId?.trim();
    const device = requestedScannerId
      ? scanners.find((scanner) => scanner.deviceId === requestedScannerId)
      : scanners[0];

    if (!device) {
      throw new Error("Selected scanner is not available. Refresh scanners and try again.");
    }

    updateJobStatus({
      jobId,
      status: "running",
      metaPatch: {
        scannerDeviceId: device.deviceId,
        scannerDescription: device.description
      }
    });

    if (isScannerProxyEnabled()) {
      await startScanJobViaProxy(jobId, options, device);
      return;
    }

    const child = createScanProcess(device.deviceId, options);
    runtimeState.processes.set(jobId, child);

    let imageWidth = 0;
    let imageChannels = 3;
    let previewWidth = 0;
    let previewHeight = 0;
    let previewRowStride = 1;
    let previewColStride = 1;
    let pixelBuffer = Buffer.alloc(0);
    let writeOffset = 0;
    let progressPercent = 0;

    const parser = new PnmStreamParser({
      onHeader: (nextHeader) => {
        imageWidth = nextHeader.width;
        imageChannels = nextHeader.channels;
        pixelBuffer = Buffer.alloc(nextHeader.width * nextHeader.height * nextHeader.channels);

        previewColStride = Math.max(1, Math.ceil(nextHeader.width / config.SCAN_PREVIEW_MAX_WIDTH));
        previewRowStride = Math.max(1, Math.ceil(nextHeader.height / config.SCAN_PREVIEW_MAX_HEIGHT));
        previewWidth = Math.ceil(nextHeader.width / previewColStride);
        previewHeight = Math.ceil(nextHeader.height / previewRowStride);

        const payload = {
          width: nextHeader.width,
          height: nextHeader.height,
          channels: nextHeader.channels,
          dpi: options.dpi,
          mode: options.mode,
          previewWidth,
          previewHeight,
          previewRowStride,
          previewColStride
        };

        publish(jobId, {
          type: "scan_header",
          payload
        });

        appendJobEvent({
          jobId,
          eventType: "scan_header",
          payload
        });
      },
      onRows: (rows, startRow, rowCount) => {
        rows.copy(pixelBuffer, writeOffset);
        writeOffset += rows.length;

        const width = imageWidth;
        const channels = imageChannels;
        const rowBytes = width * channels;
        const chunkRows = Math.max(1, config.SCAN_ROW_CHUNK);
        const previewRowBytes = previewWidth * channels;

        for (let localStart = 0; localStart < rowCount; localStart += chunkRows) {
          const localCount = Math.min(chunkRows, rowCount - localStart);
          const startByte = localStart * rowBytes;
          const endByte = startByte + localCount * rowBytes;
          const chunk = rows.subarray(startByte, endByte);

          const maxPreviewRows = Math.ceil(localCount / previewRowStride) + 1;
          const previewBuffer = Buffer.allocUnsafe(Math.max(1, maxPreviewRows * previewRowBytes));
          let previewWrite = 0;
          let previewRows = 0;
          let previewStartRow = -1;

          for (let rowOffset = 0; rowOffset < localCount; rowOffset += 1) {
            const globalRow = startRow + localStart + rowOffset;

            if (globalRow % previewRowStride !== 0) {
              continue;
            }

            const currentPreviewRow = Math.floor(globalRow / previewRowStride);
            if (previewStartRow < 0) {
              previewStartRow = currentPreviewRow;
            }

            const sourceRowStart = rowOffset * rowBytes;

            for (let x = 0; x < width; x += previewColStride) {
              const sourcePixel = sourceRowStart + x * channels;
              for (let channel = 0; channel < channels; channel += 1) {
                previewBuffer[previewWrite] = chunk[sourcePixel + channel];
                previewWrite += 1;
              }
            }

            previewRows += 1;
          }

          if (previewRows <= 0 || previewStartRow < 0) {
            continue;
          }

          publish(jobId, {
            type: "scan_rows",
            payload: {
              startRow: previewStartRow,
              rowCount: previewRows,
              channels,
              width: previewWidth,
              dataBase64: previewBuffer.subarray(0, previewWrite).toString("base64")
            }
          });
        }
      }
    });

    let stderrText = "";

    const processResult = new Promise<{ exitCode: number | null; stderr: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`scanimage timed out after ${config.SCAN_TIMEOUT_MS}ms`));
      }, config.SCAN_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        try {
          parser.push(chunk);
        } catch (error) {
          clearTimeout(timeout);
          child.kill("SIGTERM");
          reject(error);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrText += text;
        const nextProgress = parseProgressFromChunk(text, progressPercent);

        if (nextProgress !== progressPercent) {
          progressPercent = nextProgress;
          publish(jobId, {
            type: "scan_progress",
            payload: { percent: progressPercent }
          });
        }
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({ exitCode: code, stderr: stderrText });
      });
    });

    const { exitCode, stderr } = await processResult;

    if (runtimeState.canceledJobs.has(jobId)) {
      markScanCanceled(jobId);
      return;
    }

    const finalHeader = parser.getHeader();

    if (!finalHeader) {
      if (exitCode !== 0 && exitCode !== null) {
        const stderrSummary = summarizeScannerStderr(stderr);
        throw new Error(
          stderrSummary
            ? `scanimage exited with code ${exitCode}: ${stderrSummary}`
            : `scanimage exited with code ${exitCode} before image header was received`
        );
      }
      throw new Error("Scanner output did not include a valid PNM header");
    }

    const rowBytes = finalHeader.width * finalHeader.channels;
    let outputHeight = finalHeader.height;
    let partialScan = false;
    let partialReason: string | null = null;
    const rowsReceived = rowBytes > 0 ? Math.floor(writeOffset / rowBytes) : 0;

    try {
      parser.finish();
    } catch (error) {
      const parseMessage = error instanceof Error ? error.message : String(error);
      const scanEndedEarly = /Scan ended early:/i.test(parseMessage);

      if (scanEndedEarly && rowsReceived > 0) {
        partialScan = true;
        outputHeight = Math.min(rowsReceived, finalHeader.height);
        writeOffset = outputHeight * rowBytes;
        partialReason = parseMessage;
      } else if (exitCode !== 0 && exitCode !== null) {
        const stderrSummary = summarizeScannerStderr(stderr);
        throw new Error(
          stderrSummary
            ? `scanimage exited with code ${exitCode}: ${stderrSummary} (${parseMessage})`
            : `scanimage exited with code ${exitCode}: ${parseMessage}`
        );
      } else {
        throw error;
      }
    }

    const baseName = safeFileName(`${jobId}-${crypto.randomUUID()}`);
    const pngPath = path.join(dataPaths.scans, `${baseName}.png`);
    const pdfPath = path.join(dataPaths.scans, `${baseName}.pdf`);

    await sharp(pixelBuffer.subarray(0, writeOffset), {
      raw: {
        width: finalHeader.width,
        height: outputHeight,
        channels: finalHeader.channels
      }
    })
      .png()
      .toFile(pngPath);

    await writeImagePdf({
      pngPath,
      pdfPath,
      width: finalHeader.width,
      height: outputHeight,
      dpi: options.dpi
    });

    addArtifact({
      jobId,
      kind: "scan_png",
      path: pngPath,
      mime: "image/png",
      sizeBytes: fs.statSync(pngPath).size,
      sha256: sha256File(pngPath)
    });

    addArtifact({
      jobId,
      kind: "scan_pdf",
      path: pdfPath,
      mime: "application/pdf",
      sizeBytes: fs.statSync(pdfPath).size,
      sha256: sha256File(pdfPath)
    });

    const payload = {
      pngUrl: `/api/scan/jobs/${jobId}/download?format=png`,
      pdfUrl: `/api/scan/jobs/${jobId}/download?format=pdf`,
      partial: partialScan,
      expectedRows: finalHeader.height,
      actualRows: outputHeight
    };

    if (exitCode !== 0 && exitCode !== null) {
      const stderrSummary = summarizeScannerStderr(stderr);
      appendJobEvent({
        jobId,
        eventType: "scan_nonzero_exit_ignored",
        payload: {
          exitCode,
          partial: partialScan,
          expectedRows: finalHeader.height,
          actualRows: outputHeight,
          stderr: stderrSummary || null
        }
      });
      logInfo("scan completed with non-zero scanimage exit", {
        jobId,
        exitCode,
        partial: partialScan,
        expectedRows: finalHeader.height,
        actualRows: outputHeight,
        stderr: stderrSummary || null
      });
    }

    if (partialScan) {
      appendJobEvent({
        jobId,
        eventType: "scan_partial_output_saved",
        payload: {
          reason: partialReason,
          expectedRows: finalHeader.height,
          actualRows: outputHeight
        }
      });
    }

    publish(jobId, {
      type: "scan_progress",
      payload: { percent: 100 }
    });

    publish(jobId, {
      type: "scan_complete",
      payload
    });

    updateJobStatus({
      jobId,
      status: "completed",
      metaPatch: {
        width: finalHeader.width,
        height: outputHeight,
        expectedHeight: finalHeader.height,
        channels: finalHeader.channels,
        dpi: options.dpi,
        mode: options.mode,
        scannerExitCode: exitCode,
        partialScan,
        partialReason,
        output: payload
      }
    });

    appendJobEvent({
      jobId,
      eventType: "scan_completed",
      payload: {
        ...payload,
        rows: outputHeight
      }
    });

    logInfo("scan completed", {
      jobId,
      dpi: options.dpi,
      mode: options.mode,
      width: finalHeader.width,
      height: outputHeight,
      partialScan
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = summarizeText(rawMessage, 700);

    updateJobStatus({
      jobId,
      status: "failed",
      errorMessage: message
    });

    appendJobEvent({
      jobId,
      eventType: "scan_failed",
      payload: {
        error: message
      }
    });

    publish(jobId, {
      type: "scan_error",
      payload: { message }
    });

    logError("scan failed", { jobId, error: message });
  } finally {
    runtimeState.processes.delete(jobId);
    runtimeState.proxyAbortControllers.delete(jobId);
    runtimeState.canceledJobs.delete(jobId);
    runtimeState.activeJobId = null;

    setTimeout(() => {
      scanEventHub.clear(jobId);
    }, 15 * 60 * 1000).unref();
  }
}

export function cancelScanJob(jobId: string) {
  const proxyAbortController = runtimeState.proxyAbortControllers.get(jobId);
  if (proxyAbortController) {
    runtimeState.canceledJobs.add(jobId);
    proxyAbortController.abort();
    return true;
  }

  const processRef = runtimeState.processes.get(jobId);
  if (!processRef) {
    return false;
  }

  runtimeState.canceledJobs.add(jobId);
  processRef.kill("SIGTERM");
  return true;
}
