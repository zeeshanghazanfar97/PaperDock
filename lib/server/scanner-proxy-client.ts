import fs from "node:fs";
import path from "node:path";

import { config } from "@/lib/server/config";

export type OptionPrimitive = string | number | boolean;
export type OptionValue = OptionPrimitive | OptionPrimitive[] | null;

export type ScannerProxyColorMode = "Color" | "Gray" | "Lineart";
export type ScannerProxyOutputFormat = "png" | "jpeg" | "tiff" | "pnm";

interface RawScannerDevice {
  device: string;
  description: string;
}

interface RawScanDevicesResponse {
  devices?: RawScannerDevice[];
  raw?: string;
  stderr?: string;
}

interface RawPrintPrinter {
  name?: string;
  state?: string;
  raw?: string;
}

interface RawPrintPrintersResponse {
  parsed?: {
    printers?: RawPrintPrinter[];
    default_destination?: string | null;
  };
  raw?: string;
  stderr?: string;
}

export interface ScannerProxyStatusResponse {
  ok: boolean;
  scannerReachable: boolean;
  scanners: Array<{ deviceId: string; description: string }>;
  message?: string | null;
}

export interface PrintSettings {
  printer?: string | null;
  title?: string | null;
  copies?: number | null;
  job_priority?: number | null;
  page_ranges?: string | null;
  options?: Record<string, OptionValue>;
  raw_args?: string[];
  timeout_seconds?: number;
}

export interface ProxyPrintRequest extends PrintSettings {
  file_path: string;
}

export interface ProxyPrintUploadRequest extends PrintSettings {
  filePath: string;
  fileName?: string;
}

export interface ProxyPrintResponse {
  command: string[];
  return_code: number;
  job_id: string | null;
  stdout: string;
  stderr: string;
}

export interface ProxyScanRequest {
  device?: string | null;
  format?: ScannerProxyOutputFormat | null;
  mode?: string | null;
  resolution?: number | null;
  options?: Record<string, OptionValue>;
  raw_args?: string[];
  output_filename?: string | null;
  timeout_seconds?: number;
  return_base64?: boolean;
}

export interface ProxyScanResponse {
  command: string[];
  return_code: number;
  batch_mode: boolean;
  output_file?: string;
  bytes_written?: number;
  stderr: string;
  stdout?: string;
  note?: string;
  base64_data?: string;
}

export interface ProxyCopyRequest {
  scan: ProxyScanRequest;
  print_settings: PrintSettings;
  delete_scanned_file?: boolean;
}

export interface ProxyCopyResponse {
  scan: ProxyScanResponse;
  print: ProxyPrintResponse;
  scanned_file_deleted?: boolean;
}

export interface ProxyPrinterInfo {
  name: string;
  state: string;
  isDefault: boolean;
  raw: string;
}

export class ScannerProxyError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getProxyApiBaseUrl() {
  return config.PROXY_API_URL.endsWith("/") ? config.PROXY_API_URL : `${config.PROXY_API_URL}/`;
}

function buildProxyApiUrl(pathname: string) {
  const normalized = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return new URL(normalized, getProxyApiBaseUrl()).toString();
}

function noStoreHeaders(initHeaders?: HeadersInit) {
  return {
    "Cache-Control": "no-store",
    ...(initHeaders ?? {})
  };
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  if (!input.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function contentTypeFromFilename(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") {
    return "application/pdf";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".tif" || ext === ".tiff") {
    return "image/tiff";
  }
  if (ext === ".pnm" || ext === ".pbm" || ext === ".pgm" || ext === ".ppm") {
    return "image/x-portable-anymap";
  }
  return "application/octet-stream";
}

async function readErrorMessage(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return `Proxy API request failed (${response.status})`;
  }

  const parsed = parseJsonObject(text);
  if (!parsed) {
    return text;
  }

  const detail = parsed.detail;

  if (typeof detail === "string") {
    return detail;
  }

  if (detail && typeof detail === "object") {
    const message = (detail as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }

    try {
      return JSON.stringify(detail);
    } catch {
      return text;
    }
  }

  const error = parsed.error;
  if (typeof error === "string") {
    return error;
  }

  return text;
}

function parsePrinterListFromRaw(raw: string, defaultPrinter: string | null): ProxyPrinterInfo[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("printer "))
    .map((line) => {
      const match = line.match(/^printer\s+(\S+)\s+is\s+(.+?)\.?$/);
      if (!match) {
        return null;
      }

      const name = match[1];
      const state = match[2] ?? "unknown";

      return {
        name,
        state,
        isDefault: defaultPrinter === name,
        raw: line
      };
    })
    .filter((item): item is ProxyPrinterInfo => Boolean(item));
}

function normalizePrinterList(
  printers: RawPrintPrinter[] | undefined,
  defaultPrinter: string | null,
  rawOutput: string
): ProxyPrinterInfo[] {
  const normalized = (printers ?? [])
    .map((printer) => {
      const name = printer.name;
      if (!name) {
        return null;
      }

      return {
        name,
        state: printer.state ?? "unknown",
        isDefault: defaultPrinter === name,
        raw: printer.raw ?? ""
      };
    })
    .filter((item): item is ProxyPrinterInfo => Boolean(item));

  if (normalized.length > 0) {
    return normalized;
  }

  return parsePrinterListFromRaw(rawOutput, defaultPrinter);
}

export async function requestProxyHealth(signal?: AbortSignal) {
  const response = await fetch(buildProxyApiUrl("/health"), {
    method: "GET",
    cache: "no-store",
    signal,
    headers: noStoreHeaders()
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    return { status: "unknown" };
  }

  return {
    status: asString((payload as Record<string, unknown>).status, "unknown")
  };
}

export async function requestProxyScanDevices(signal?: AbortSignal) {
  const response = await fetch(buildProxyApiUrl("/scan/devices"), {
    method: "GET",
    cache: "no-store",
    signal,
    headers: noStoreHeaders()
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as RawScanDevicesResponse;
  return (payload.devices ?? []).map((device) => ({
    deviceId: device.device,
    description: device.description
  }));
}

export async function requestScannerProxyStatus(signal?: AbortSignal): Promise<ScannerProxyStatusResponse> {
  const [health, scanners] = await Promise.all([requestProxyHealth(signal), requestProxyScanDevices(signal)]);

  return {
    ok: health.status === "healthy" || health.status === "ok",
    scannerReachable: true,
    scanners,
    message: null
  };
}

export async function requestProxyPrinters(signal?: AbortSignal): Promise<{
  printers: ProxyPrinterInfo[];
  defaultPrinter: string | null;
  raw: string;
  stderr: string;
}> {
  const response = await fetch(buildProxyApiUrl("/print/printers"), {
    method: "GET",
    cache: "no-store",
    signal,
    headers: noStoreHeaders()
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as RawPrintPrintersResponse;
  const raw = payload.raw ?? "";
  const stderr = payload.stderr ?? "";
  const defaultPrinter = payload.parsed?.default_destination ?? null;

  const printers = normalizePrinterList(payload.parsed?.printers, defaultPrinter, raw);

  if (!printers.some((printer) => printer.isDefault) && printers.length > 0) {
    printers[0] = {
      ...printers[0],
      isDefault: true
    };
  }

  return {
    printers,
    defaultPrinter: printers.find((printer) => printer.isDefault)?.name ?? defaultPrinter,
    raw,
    stderr
  };
}

export async function requestProxyPrintJob(request: ProxyPrintRequest, signal?: AbortSignal): Promise<ProxyPrintResponse> {
  const response = await fetch(buildProxyApiUrl("/print/jobs"), {
    method: "POST",
    cache: "no-store",
    signal,
    headers: noStoreHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as Record<string, unknown>;

  return {
    command: asStringArray(payload.command),
    return_code: asNumber(payload.return_code),
    job_id: asNullableString(payload.job_id),
    stdout: asString(payload.stdout),
    stderr: asString(payload.stderr)
  };
}

export async function requestProxyPrintUpload(
  request: ProxyPrintUploadRequest,
  signal?: AbortSignal
): Promise<ProxyPrintResponse> {
  if (!fs.existsSync(request.filePath)) {
    throw new Error(`Print upload file missing: ${request.filePath}`);
  }

  const fileName = request.fileName ?? path.basename(request.filePath);
  const fileContent = fs.readFileSync(request.filePath);
  const formData = new FormData();

  formData.append("file", new Blob([fileContent], { type: contentTypeFromFilename(fileName) }), fileName);

  if (request.printer) {
    formData.set("printer", request.printer);
  }
  if (request.title) {
    formData.set("title", request.title);
  }
  if (typeof request.copies === "number") {
    formData.set("copies", String(request.copies));
  }
  if (typeof request.job_priority === "number") {
    formData.set("job_priority", String(request.job_priority));
  }
  if (request.page_ranges) {
    formData.set("page_ranges", request.page_ranges);
  }
  if (request.options) {
    formData.set("options_json", JSON.stringify(request.options));
  }
  if (request.raw_args) {
    formData.set("raw_args_json", JSON.stringify(request.raw_args));
  }
  if (typeof request.timeout_seconds === "number") {
    formData.set("timeout_seconds", String(request.timeout_seconds));
  }

  const response = await fetch(buildProxyApiUrl("/print/upload"), {
    method: "POST",
    cache: "no-store",
    signal,
    headers: noStoreHeaders(),
    body: formData
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as Record<string, unknown>;

  return {
    command: asStringArray(payload.command),
    return_code: asNumber(payload.return_code),
    job_id: asNullableString(payload.job_id),
    stdout: asString(payload.stdout),
    stderr: asString(payload.stderr)
  };
}

export async function requestProxyPrintJobs(
  params: {
    printer?: string;
  } = {},
  signal?: AbortSignal
): Promise<{ printer: string | null; raw: string; stderr: string; ids: Set<string> }> {
  const url = new URL(buildProxyApiUrl("/print/jobs"));
  if (params.printer) {
    url.searchParams.set("printer", params.printer);
  }

  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    signal,
    headers: noStoreHeaders()
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const raw = asString(payload.raw);

  const ids = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter((value): value is string => Boolean(value));

  return {
    printer: asNullableString(payload.printer),
    raw,
    stderr: asString(payload.stderr),
    ids: new Set(ids)
  };
}

export async function requestProxyCancelPrintJob(jobId: string, signal?: AbortSignal) {
  const response = await fetch(buildProxyApiUrl(`/print/jobs/${encodeURIComponent(jobId)}/cancel`), {
    method: "POST",
    cache: "no-store",
    signal,
    headers: noStoreHeaders()
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as Record<string, unknown>;

  return {
    job_id: asString(payload.job_id),
    command: asStringArray(payload.command),
    return_code: asNumber(payload.return_code),
    stdout: asString(payload.stdout),
    stderr: asString(payload.stderr)
  };
}

export async function requestProxyScan(request: ProxyScanRequest, signal?: AbortSignal): Promise<ProxyScanResponse> {
  const response = await fetch(buildProxyApiUrl("/scan"), {
    method: "POST",
    cache: "no-store",
    signal,
    headers: noStoreHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as Record<string, unknown>;

  return {
    command: asStringArray(payload.command),
    return_code: asNumber(payload.return_code),
    batch_mode: Boolean(payload.batch_mode),
    output_file: asNullableString(payload.output_file) ?? undefined,
    bytes_written: typeof payload.bytes_written === "number" ? payload.bytes_written : undefined,
    stderr: asString(payload.stderr),
    stdout: asNullableString(payload.stdout) ?? undefined,
    note: asNullableString(payload.note) ?? undefined,
    base64_data: asNullableString(payload.base64_data) ?? undefined
  };
}

export async function requestProxyScanDownload(request: ProxyScanRequest, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(buildProxyApiUrl("/scan/download"), {
    method: "POST",
    cache: "no-store",
    signal,
    headers: noStoreHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  return response;
}

export async function requestProxyCopy(request: ProxyCopyRequest, signal?: AbortSignal): Promise<ProxyCopyResponse> {
  const response = await fetch(buildProxyApiUrl("/copy"), {
    method: "POST",
    cache: "no-store",
    signal,
    headers: noStoreHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new ScannerProxyError(await readErrorMessage(response), response.status);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const scan = (payload.scan ?? {}) as Record<string, unknown>;
  const print = (payload.print ?? {}) as Record<string, unknown>;

  return {
    scan: {
      command: asStringArray(scan.command),
      return_code: asNumber(scan.return_code),
      batch_mode: Boolean(scan.batch_mode),
      output_file: asNullableString(scan.output_file) ?? undefined,
      bytes_written: typeof scan.bytes_written === "number" ? scan.bytes_written : undefined,
      stderr: asString(scan.stderr),
      stdout: asNullableString(scan.stdout) ?? undefined,
      note: asNullableString(scan.note) ?? undefined,
      base64_data: asNullableString(scan.base64_data) ?? undefined
    },
    print: {
      command: asStringArray(print.command),
      return_code: asNumber(print.return_code),
      job_id: asNullableString(print.job_id),
      stdout: asString(print.stdout),
      stderr: asString(print.stderr)
    },
    scanned_file_deleted: typeof payload.scanned_file_deleted === "boolean" ? payload.scanned_file_deleted : undefined
  };
}
