export interface ScannerInfo {
  deviceId: string;
  description: string;
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
