import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

function toPositiveInt(value, fallback, min = 1) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min) {
    return fallback;
  }
  return numeric;
}

const config = {
  host: process.env.PROXY_HOST || "0.0.0.0",
  port: toPositiveInt(process.env.PROXY_PORT, 3412),
  dataDir: process.env.PROXY_DATA_DIR || path.join(process.cwd(), "data"),
  token: (process.env.PROXY_TOKEN || "").trim(),
  scanListTimeoutMs: toPositiveInt(process.env.SCAN_LIST_TIMEOUT_MS, 30_000),
  scanTimeoutMs: toPositiveInt(process.env.SCAN_TIMEOUT_MS, 8 * 60 * 1000),
  scanRowChunk: toPositiveInt(process.env.SCAN_ROW_CHUNK, 32),
  previewMaxWidth: toPositiveInt(process.env.SCAN_PREVIEW_MAX_WIDTH, 900),
  previewMaxHeight: toPositiveInt(process.env.SCAN_PREVIEW_MAX_HEIGHT, 1400),
  resultTtlMs: toPositiveInt(process.env.RESULT_TTL_MS, 30 * 60 * 1000)
};

const dataPaths = {
  root: config.dataDir,
  scans: path.join(config.dataDir, "scans")
};

for (const directory of Object.values(dataPaths)) {
  fs.mkdirSync(directory, { recursive: true });
}

const scannerCache = {
  scanners: [],
  updatedAt: 0
};

const resultStore = new Map();

function log(level, message, details = null) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(details ? { details } : {})
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0b || byte === 0x0c;
}

function parsePnmHeader(buffer) {
  let index = 0;
  const tokens = [];

  while (tokens.length < 4) {
    while (index < buffer.length) {
      const ch = buffer[index];
      if (isWhitespace(ch)) {
        index += 1;
        continue;
      }
      if (ch === 0x23) {
        while (index < buffer.length && buffer[index] !== 0x0a) {
          index += 1;
        }
        continue;
      }
      break;
    }

    if (index >= buffer.length) {
      return null;
    }

    const start = index;
    while (index < buffer.length && !isWhitespace(buffer[index]) && buffer[index] !== 0x23) {
      index += 1;
    }

    if (index >= buffer.length) {
      return null;
    }

    tokens.push(buffer.toString("ascii", start, index));
  }

  if (!isWhitespace(buffer[index])) {
    return null;
  }

  const magic = tokens[0];
  if (magic !== "P5" && magic !== "P6") {
    throw new Error(`Unsupported PNM format: ${magic}`);
  }

  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const maxValue = Number(tokens[3]);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid PNM dimensions");
  }

  if (!Number.isFinite(maxValue) || maxValue <= 0 || maxValue > 255) {
    throw new Error(`Unsupported PNM max value: ${tokens[3]}`);
  }

  return {
    header: {
      magic,
      width,
      height,
      maxValue,
      channels: magic === "P6" ? 3 : 1
    },
    dataStart: index + 1
  };
}

class PnmStreamParser {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.header = null;
    this.rawHeaderBuffer = Buffer.alloc(0);
    this.remainder = Buffer.alloc(0);
    this.rowCursor = 0;
  }

  push(chunk) {
    if (!this.header) {
      this.rawHeaderBuffer = Buffer.concat([this.rawHeaderBuffer, chunk]);
      const parsed = parsePnmHeader(this.rawHeaderBuffer);

      if (!parsed) {
        return;
      }

      this.header = parsed.header;
      this.callbacks.onHeader(parsed.header);

      const initialData = this.rawHeaderBuffer.subarray(parsed.dataStart);
      this.rawHeaderBuffer = Buffer.alloc(0);
      this.consumePixelData(initialData);
      return;
    }

    this.consumePixelData(chunk);
  }

  getHeader() {
    return this.header;
  }

  finish() {
    if (!this.header) {
      throw new Error("PNM header missing");
    }

    if (this.rowCursor !== this.header.height) {
      throw new Error(`Scan ended early: expected ${this.header.height} rows, got ${this.rowCursor}`);
    }
  }

  consumePixelData(chunk) {
    if (!this.header) {
      throw new Error("PNM header missing");
    }

    const rowBytes = this.header.width * this.header.channels;
    const combined = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;

    if (!combined.length) {
      return;
    }

    const availableRows = Math.floor(combined.length / rowBytes);
    const maxRows = this.header.height - this.rowCursor;
    const rowsToEmit = Math.min(availableRows, maxRows);

    if (rowsToEmit <= 0) {
      this.remainder = Buffer.from(combined);
      return;
    }

    const bytesToEmit = rowsToEmit * rowBytes;
    const rowPayload = combined.subarray(0, bytesToEmit);

    this.callbacks.onRows(rowPayload, this.rowCursor, rowsToEmit);
    this.rowCursor += rowsToEmit;

    this.remainder = Buffer.from(combined.subarray(bytesToEmit));
  }
}

function normalizeMessage(input, maxChars = 500) {
  const normalized = String(input || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function summarizeScannerStderr(stderr, maxChars = 500) {
  const withoutProgress = String(stderr || "").replace(/Progress:\s*\d+(?:\.\d+)?%\s*/g, " ");
  return normalizeMessage(withoutProgress, maxChars);
}

function parseProgressFromChunk(chunk, previousPercent) {
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

function parseScannerLine(line) {
  const quoted = line.match(/^device\s+[`'"](.+?)[`'"]\s+is\s+(.+)$/i);
  if (quoted) {
    return {
      deviceId: quoted[1],
      description: quoted[2]
    };
  }

  const unquoted = line.match(/^device\s+(\S+)\s+is\s+(.+)$/i);
  if (unquoted) {
    return {
      deviceId: unquoted[1],
      description: unquoted[2]
    };
  }

  return null;
}

function parseScannerList(output) {
  return String(output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^device\b/i.test(line))
    .map((line) => parseScannerLine(line))
    .filter(Boolean);
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stdout: stdout || "", stderr: stderr || "" });
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function discoverScanners(forceRefresh = false) {
  if (!forceRefresh && scannerCache.scanners.length) {
    return scannerCache.scanners;
  }

  let scanners = [];

  try {
    const response = await runCommand("scanimage", ["-L"], config.scanListTimeoutMs);
    scanners = parseScannerList(`${response.stdout}\n${response.stderr}`);
  } catch (failure) {
    scanners = parseScannerList(`${failure.stdout || ""}\n${failure.stderr || ""}`);
    if (!scanners.length) {
      const detail = normalizeMessage(failure.stderr || failure.stdout || failure.error?.message || "");
      throw new Error(detail ? `scanimage -L failed: ${detail}` : "scanimage -L failed");
    }
  }

  scannerCache.scanners = scanners;
  scannerCache.updatedAt = Date.now();
  return scanners;
}

async function writeImagePdf({ pngPath, pdfPath, width, height, dpi }) {
  const pngBytes = fs.readFileSync(pngPath);
  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedPng(pngBytes);

  const widthPt = (width * 72) / dpi;
  const heightPt = (height * 72) / dpi;

  const page = pdf.addPage([widthPt, heightPt]);
  page.drawImage(embedded, {
    x: 0,
    y: 0,
    width: widthPt,
    height: heightPt
  });

  const pdfBytes = await pdf.save();
  fs.writeFileSync(pdfPath, pdfBytes);
}

function sendJson(res, status, payload) {
  if (res.writableEnded) {
    return;
  }

  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function sendNdjson(res, type, payload) {
  if (res.writableEnded) {
    return;
  }

  res.write(`${JSON.stringify({ type, payload })}\n`);
}

function requiresAuth(req) {
  if (!config.token) {
    return false;
  }

  const header = req.headers.authorization || "";
  return header !== `Bearer ${config.token}`;
}

async function readJsonBody(req, maxBytes = 128 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const next = Buffer.from(chunk);
    total += next.length;

    if (total > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }

    chunks.push(next);
  }

  if (!chunks.length) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON payload");
  }
}

function cleanupResults() {
  const now = Date.now();

  for (const [sessionId, entry] of resultStore.entries()) {
    if (entry.expiresAt > now) {
      continue;
    }

    for (const filePath of [entry.pngPath, entry.pdfPath]) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        log("warn", "failed to delete expired scan result", {
          sessionId,
          filePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    resultStore.delete(sessionId);
  }
}

setInterval(cleanupResults, 5 * 60 * 1000).unref();

async function handleScanStream(req, res) {
  const body = await readJsonBody(req);

  const dpi = Math.min(600, Math.max(75, toPositiveInt(body.dpi, 150, 75)));
  const mode = body.mode === "Gray" ? "Gray" : "Color";
  const requestedDeviceId = typeof body.scannerDeviceId === "string" ? body.scannerDeviceId.trim() : "";
  const rowChunk = toPositiveInt(body.rowChunk, config.scanRowChunk);
  const previewMaxWidth = toPositiveInt(body.previewMaxWidth, config.previewMaxWidth);
  const previewMaxHeight = toPositiveInt(body.previewMaxHeight, config.previewMaxHeight);

  let scanners = await discoverScanners(false);
  if (!scanners.length) {
    sendJson(res, 503, { error: "No scanner devices discovered by scanimage -L" });
    return;
  }

  let device = requestedDeviceId ? scanners.find((item) => item.deviceId === requestedDeviceId) : scanners[0];

  if (!device && requestedDeviceId) {
    scanners = await discoverScanners(true);
    device = scanners.find((item) => item.deviceId === requestedDeviceId) || null;
  }

  if (!device) {
    sendJson(res, 400, { error: "Selected scanner is not available. Refresh scanners and try again." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const sessionId = randomUUID();
  const args = [
    "--device-name",
    device.deviceId,
    "--format=pnm",
    "--progress",
    "--resolution",
    String(dpi),
    "--mode",
    mode
  ];

  const child = spawn("scanimage", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let closed = false;
  const closeHandler = () => {
    closed = true;
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  req.on("aborted", closeHandler);
  res.on("close", closeHandler);

  let imageWidth = 0;
  let imageChannels = 3;
  let previewWidth = 0;
  let previewHeight = 0;
  let previewRowStride = 1;
  let previewColStride = 1;
  let pixelBuffer = Buffer.alloc(0);
  let writeOffset = 0;
  let progressPercent = 0;
  let stderrText = "";

  const parser = new PnmStreamParser({
    onHeader: (header) => {
      imageWidth = header.width;
      imageChannels = header.channels;
      pixelBuffer = Buffer.alloc(header.width * header.height * header.channels);

      previewColStride = Math.max(1, Math.ceil(header.width / previewMaxWidth));
      previewRowStride = Math.max(1, Math.ceil(header.height / previewMaxHeight));
      previewWidth = Math.ceil(header.width / previewColStride);
      previewHeight = Math.ceil(header.height / previewRowStride);

      const payload = {
        width: header.width,
        height: header.height,
        channels: header.channels,
        dpi,
        mode,
        scannerDeviceId: device.deviceId,
        scannerDescription: device.description,
        previewWidth,
        previewHeight,
        previewRowStride,
        previewColStride
      };

      sendNdjson(res, "scan_header", payload);
    },
    onRows: (rows, startRow, rowCount) => {
      rows.copy(pixelBuffer, writeOffset);
      writeOffset += rows.length;

      const width = imageWidth;
      const channels = imageChannels;
      const rowBytes = width * channels;
      const previewRowBytes = previewWidth * channels;

      for (let localStart = 0; localStart < rowCount; localStart += rowChunk) {
        const localCount = Math.min(rowChunk, rowCount - localStart);
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

        sendNdjson(res, "scan_rows", {
          startRow: previewStartRow,
          rowCount: previewRows,
          channels,
          width: previewWidth,
          dataBase64: previewBuffer.subarray(0, previewWrite).toString("base64")
        });
      }
    }
  });

  const processResult = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      reject(new Error(`scanimage timed out after ${config.scanTimeoutMs}ms`));
    }, config.scanTimeoutMs);

    child.stdout.on("data", (chunk) => {
      try {
        parser.push(Buffer.from(chunk));
      } catch (error) {
        clearTimeout(timeout);
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        reject(error);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = Buffer.from(chunk).toString("utf8");
      stderrText += text;
      const nextProgress = parseProgressFromChunk(text, progressPercent);

      if (nextProgress !== progressPercent) {
        progressPercent = nextProgress;
        sendNdjson(res, "scan_progress", { percent: progressPercent });
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

  let pngPath = "";
  let pdfPath = "";

  try {
    const { exitCode, stderr } = await processResult;

    if (closed) {
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

    const baseName = `${sessionId}-${randomUUID()}`;
    pngPath = path.join(dataPaths.scans, `${baseName}.png`);
    pdfPath = path.join(dataPaths.scans, `${baseName}.pdf`);

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
      dpi
    });

    resultStore.set(sessionId, {
      pngPath,
      pdfPath,
      createdAt: Date.now(),
      expiresAt: Date.now() + config.resultTtlMs
    });

    sendNdjson(res, "scan_progress", { percent: 100 });
    sendNdjson(res, "scan_complete", {
      sessionId,
      scannerDeviceId: device.deviceId,
      scannerDescription: device.description,
      width: finalHeader.width,
      height: outputHeight,
      channels: finalHeader.channels,
      partial: partialScan,
      expectedRows: finalHeader.height,
      actualRows: outputHeight,
      scannerExitCode: exitCode
    });

    if (!res.writableEnded) {
      res.end();
    }

    log("info", "scan complete", {
      sessionId,
      scannerDeviceId: device.deviceId,
      width: finalHeader.width,
      height: outputHeight,
      partial: partialScan,
      exitCode
    });
  } catch (error) {
    if (pngPath && fs.existsSync(pngPath)) {
      fs.unlinkSync(pngPath);
    }

    if (pdfPath && fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }

    if (!closed) {
      sendNdjson(res, "scan_error", {
        message: normalizeMessage(error instanceof Error ? error.message : String(error), 700)
      });
      if (!res.writableEnded) {
        res.end();
      }
    }

    log("error", "scan failed", {
      scannerDeviceId: device.deviceId,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    req.off("aborted", closeHandler);
    res.off("close", closeHandler);
  }
}

async function routeRequest(req, res) {
  const method = req.method || "GET";
  const origin = `http://${req.headers.host || "localhost"}`;
  const url = new URL(req.url || "/", origin);

  if (method === "GET" && url.pathname === "/") {
    sendJson(res, 200, {
      name: "paperdock-scanner-proxy",
      ok: true
    });
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    try {
      const [whichScanimage] = await Promise.all([runCommand("which", ["scanimage"], 8_000)]);
      sendJson(res, 200, {
        ok: true,
        dependencies: {
          scanimage: whichScanimage.stdout.trim()
        },
        scannersCached: scannerCache.scanners.length,
        resultsCached: resultStore.size
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (requiresAuth(req)) {
    sendJson(res, 401, {
      error: "Unauthorized"
    });
    return;
  }

  if (method === "GET" && url.pathname === "/scanners") {
    try {
      const refresh = url.searchParams.get("refresh");
      const forceRefresh = refresh === "1" || refresh === "true";
      const scanners = await discoverScanners(forceRefresh);
      sendJson(res, 200, {
        scanners,
        selectedScanner: scanners[0] || null
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/scan/stream") {
    try {
      await handleScanStream(req, res);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  const match = url.pathname.match(/^\/scan\/results\/([^/]+)$/);
  if (method === "GET" && match) {
    const sessionId = decodeURIComponent(match[1]);
    const format = url.searchParams.get("format");

    if (format !== "png" && format !== "pdf") {
      sendJson(res, 400, {
        error: "format must be png or pdf"
      });
      return;
    }

    const entry = resultStore.get(sessionId);
    if (!entry) {
      sendJson(res, 404, {
        error: "Scan result session not found"
      });
      return;
    }

    const filePath = format === "png" ? entry.pngPath : entry.pdfPath;
    if (!fs.existsSync(filePath)) {
      sendJson(res, 410, {
        error: "Scan result missing from disk"
      });
      return;
    }

    const body = fs.readFileSync(filePath);
    const mime = format === "png" ? "image/png" : "application/pdf";

    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename=\"scan-${sessionId}.${format}\"`);
    res.end(body);
    return;
  }

  sendJson(res, 404, {
    error: "Not found"
  });
}

const server = createServer((req, res) => {
  routeRequest(req, res).catch((error) => {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  });
});

server.listen(config.port, config.host, () => {
  log("info", "scanner proxy listening", {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    authEnabled: Boolean(config.token)
  });
});
