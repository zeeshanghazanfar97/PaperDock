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
import { scanEventHub } from "@/lib/server/scan-events";
import type { SseJobEvent } from "@/lib/types/jobs";

interface ScanOptions {
  dpi: number;
  mode: "Color" | "Gray";
}

interface ScanRuntimeState {
  activeJobId: string | null;
  processes: Map<string, ReturnType<typeof spawnCommand>>;
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
      mode: options.mode
    }
  });

  try {
    const scanners = await discoverScanners();
    if (!scanners.length) {
      throw new Error("No scanner devices discovered by scanimage -L");
    }

    const device = scanners[0];

    updateJobStatus({
      jobId,
      status: "running",
      metaPatch: {
        scannerDeviceId: device.deviceId,
        scannerDescription: device.description
      }
    });

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
    runtimeState.canceledJobs.delete(jobId);
    runtimeState.activeJobId = null;

    setTimeout(() => {
      scanEventHub.clear(jobId);
    }, 15 * 60 * 1000).unref();
  }
}

export function cancelScanJob(jobId: string) {
  const processRef = runtimeState.processes.get(jobId);
  if (!processRef) {
    return false;
  }

  runtimeState.canceledJobs.add(jobId);
  processRef.kill("SIGTERM");
  return true;
}
