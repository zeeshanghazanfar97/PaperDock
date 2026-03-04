import { CommandError, runCommand } from "@/lib/server/commands";
import { config } from "@/lib/server/config";
import { getCacheValue, setCacheValue } from "@/lib/server/job-store";
import { isScannerProxyEnabled, readResponseJson, scannerProxyFetch } from "@/lib/server/scanner-proxy";

export interface ScannerInfo {
  deviceId: string;
  description: string;
}

interface DiscoverScannersOptions {
  forceRefresh?: boolean;
}

const SCANNERS_CACHE_KEY = "scanners";

function normalizeMessage(input: string, maxChars = 320) {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function parseScannerLine(line: string): ScannerInfo | null {
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

export function parseScannerList(output: string): ScannerInfo[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^device\b/i.test(line))
    .map((line) => parseScannerLine(line))
    .filter((item): item is ScannerInfo => Boolean(item));
}

async function scanScannersFromSystem(): Promise<ScannerInfo[]> {
  let scanners: ScannerInfo[] = [];

  try {
    const response = await runCommand("scanimage", ["-L"], {
      timeoutMs: config.PRINT_TIMEOUT_MS
    });
    scanners = parseScannerList([response.stdout, response.stderr].filter(Boolean).join("\n"));
  } catch (error) {
    if (!(error instanceof CommandError)) {
      throw error;
    }

    scanners = parseScannerList([error.stdout, error.stderr].filter(Boolean).join("\n"));
    if (!scanners.length) {
      const details = normalizeMessage(error.stderr || error.stdout);
      throw new Error(details ? `scanimage -L failed: ${details}` : "scanimage -L failed");
    }
  }

  return scanners;
}

function isScannerInfo(value: unknown): value is ScannerInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.deviceId === "string" && typeof candidate.description === "string";
}

async function scanScannersFromProxy(forceRefresh = false): Promise<ScannerInfo[]> {
  const query = forceRefresh ? "?refresh=1" : "";
  const response = await scannerProxyFetch(`/scanners${query}`, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const payload = await readResponseJson(response);
  if (!response.ok) {
    const errorMessage =
      typeof payload.error === "string"
        ? payload.error
        : `scanner proxy request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  const scanners = Array.isArray(payload.scanners) ? payload.scanners.filter(isScannerInfo) : [];
  return scanners;
}

export function getCachedScanners(): ScannerInfo[] | null {
  const cached = getCacheValue<ScannerInfo[]>(SCANNERS_CACHE_KEY);
  return cached?.value ?? null;
}

export async function discoverScanners(options: DiscoverScannersOptions = {}): Promise<ScannerInfo[]> {
  if (!options.forceRefresh) {
    const cached = getCachedScanners();
    if (cached) {
      return cached;
    }
  }

  const scanners = isScannerProxyEnabled()
    ? await scanScannersFromProxy(options.forceRefresh)
    : await scanScannersFromSystem();
  setCacheValue(SCANNERS_CACHE_KEY, scanners);
  return scanners;
}
