import { CommandError, runCommand } from "@/lib/server/commands";
import { config } from "@/lib/server/config";
import { getCacheValue, setCacheValue } from "@/lib/server/job-store";

export interface ScannerInfo {
  deviceId: string;
  description: string;
}

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

export async function discoverScanners(): Promise<ScannerInfo[]> {
  const cached = getCacheValue<ScannerInfo[]>("scanners");

  if (cached && Date.now() - cached.updatedAt < 15_000) {
    return cached.value;
  }

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

  if (scanners.length) {
    setCacheValue("scanners", scanners);
  }
  return scanners;
}
