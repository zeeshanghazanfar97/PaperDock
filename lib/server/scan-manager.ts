import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { addArtifact, appendJobEvent, updateJobStatus } from "@/lib/server/job-store";
import { logError, logInfo } from "@/lib/server/logger";
import { dataPaths } from "@/lib/server/paths";
import {
  ScannerProxyError,
  requestProxyScan,
  type ScannerProxyColorMode,
  type ScannerProxyOutputFormat
} from "@/lib/server/scanner-proxy-client";
import { sha256File } from "@/lib/server/hash";
import { config } from "@/lib/server/config";
import { scanEventHub } from "@/lib/server/scan-events";
import type { SseJobEvent } from "@/lib/types/jobs";

interface ScanOptions {
  dpi: number;
  mode: ScannerProxyColorMode;
  format: ScannerProxyOutputFormat;
}

interface ScanRuntimeState {
  activeJobId: string | null;
  abortControllers: Map<string, AbortController>;
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
    abortControllers: new Map<string, AbortController>(),
    canceledJobs: new Set<string>()
  } satisfies ScanRuntimeState);

if (process.env.NODE_ENV !== "production") {
  global.__scanRuntimeState = runtimeState;
}

function publish(jobId: string, event: SseJobEvent) {
  scanEventHub.publish(jobId, event);
}

function summarizeText(input: string, maxChars = 700) {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function buildOutputPayload(jobId: string, format: ScannerProxyOutputFormat) {
  const primaryUrl = `/api/scan/jobs/${jobId}/download?format=${format}`;
  return {
    pngUrl: primaryUrl,
    pdfUrl: `/api/scan/jobs/${jobId}/download?format=pdf`
  };
}

function artifactKindForFormat(format: ScannerProxyOutputFormat) {
  if (format === "png") {
    return "scan_png" as const;
  }

  if (format === "jpeg") {
    return "scan_jpeg" as const;
  }

  if (format === "tiff") {
    return "scan_tiff" as const;
  }

  return "scan_pnm" as const;
}

function extensionForFormat(format: ScannerProxyOutputFormat) {
  if (format === "jpeg") {
    return "jpg";
  }
  return format;
}

function contentTypeForFormat(format: ScannerProxyOutputFormat) {
  if (format === "png") {
    return "image/png";
  }
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "tiff") {
    return "image/tiff";
  }
  return "image/x-portable-anymap";
}

function persistScanArtifact(jobId: string, format: ScannerProxyOutputFormat, bytes: Buffer) {
  const extension = extensionForFormat(format);
  const filename = `scan-${jobId}-${crypto.randomUUID()}.${extension}`;
  const filePath = path.join(dataPaths.scans, filename);

  fs.writeFileSync(filePath, bytes);

  const kind = artifactKindForFormat(format);
  addArtifact({
    jobId,
    kind,
    path: filePath,
    mime: contentTypeForFormat(format),
    sizeBytes: bytes.byteLength,
    sha256: sha256File(filePath)
  });

  return {
    filename,
    filePath,
    kind,
    sizeBytes: bytes.byteLength
  };
}

function markJobCanceled(jobId: string) {
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

  logInfo("scan canceled", { jobId });
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
      mode: options.mode,
      outputFormat: options.format
    }
  });

  appendJobEvent({
    jobId,
    eventType: "scan_started",
    payload: {
      dpi: options.dpi,
      mode: options.mode,
      format: options.format
    }
  });

  publish(jobId, {
    type: "scan_progress",
    payload: { percent: 5 }
  });

  const abortController = new AbortController();
  runtimeState.abortControllers.set(jobId, abortController);

  try {
    const scanResult = await requestProxyScan(
      {
        resolution: options.dpi,
        mode: options.mode,
        format: options.format,
        timeout_seconds: Math.max(5, Math.ceil(config.SCAN_TIMEOUT_MS / 1000)),
        return_base64: true
      },
      abortController.signal
    );

    if (runtimeState.canceledJobs.has(jobId)) {
      markJobCanceled(jobId);
      return;
    }

    if (scanResult.batch_mode) {
      throw new Error("Batch scans are not supported by this app flow");
    }

    if (!scanResult.base64_data) {
      throw new Error("Proxy scan response did not include base64_data");
    }

    const scanBytes = Buffer.from(scanResult.base64_data, "base64");

    if (!scanBytes.byteLength) {
      throw new Error("Scanned file is empty");
    }

    const artifact = persistScanArtifact(jobId, options.format, scanBytes);
    const payload = buildOutputPayload(jobId, options.format);

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
        dpi: options.dpi,
        mode: options.mode,
        outputFormat: options.format,
        scanFilename: artifact.filename,
        scanKind: artifact.kind,
        scanSizeBytes: artifact.sizeBytes,
        output: payload
      }
    });

    appendJobEvent({
      jobId,
      eventType: "scan_completed",
      payload: {
        ...payload,
        filename: artifact.filename,
        outputFormat: options.format,
        sizeBytes: artifact.sizeBytes
      }
    });

    logInfo("scan completed via proxy", {
      jobId,
      dpi: options.dpi,
      mode: options.mode,
      format: options.format,
      filename: artifact.filename,
      sizeBytes: artifact.sizeBytes
    });
  } catch (error) {
    if (runtimeState.canceledJobs.has(jobId) || (error instanceof Error && error.name === "AbortError")) {
      markJobCanceled(jobId);
      return;
    }

    const rawMessage =
      error instanceof ScannerProxyError
        ? `Proxy API (${error.status}): ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);

    const message = summarizeText(rawMessage);

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

    logError("scan failed", {
      jobId,
      error: message
    });
  } finally {
    runtimeState.abortControllers.delete(jobId);
    runtimeState.canceledJobs.delete(jobId);
    runtimeState.activeJobId = null;

    setTimeout(() => {
      scanEventHub.clear(jobId);
    }, 15 * 60 * 1000).unref();
  }
}

export function cancelScanJob(jobId: string) {
  const abortController = runtimeState.abortControllers.get(jobId);
  if (!abortController) {
    return false;
  }

  runtimeState.canceledJobs.add(jobId);
  abortController.abort();
  return true;
}
