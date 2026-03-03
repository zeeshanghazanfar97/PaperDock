import { config } from "@/lib/server/config";
import { runCommand } from "@/lib/server/commands";
import { getCacheValue, setCacheValue } from "@/lib/server/job-store";

export interface PrinterInfo {
  name: string;
  state: string;
  isDefault: boolean;
}

function parsePrinterList(output: string, defaultPrinter: string | null): PrinterInfo[] {
  return output
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
        isDefault: defaultPrinter === name
      };
    })
    .filter((item): item is PrinterInfo => Boolean(item));
}

async function getDefaultPrinter() {
  const response = await runCommand("lpstat", ["-h", config.CUPS_HOST, "-d"], {
    timeoutMs: config.PRINT_TIMEOUT_MS
  });

  const match = response.stdout.match(/system default destination:\s*(\S+)/i);
  return match?.[1] ?? null;
}

export async function discoverPrinters(): Promise<PrinterInfo[]> {
  const cached = getCacheValue<PrinterInfo[]>("printers");

  if (cached && Date.now() - cached.updatedAt < 15_000) {
    return cached.value;
  }

  const [defaultPrinter, printersResp] = await Promise.all([
    getDefaultPrinter(),
    runCommand("lpstat", ["-h", config.CUPS_HOST, "-p"], { timeoutMs: config.PRINT_TIMEOUT_MS })
  ]);

  const printers = parsePrinterList(printersResp.stdout, defaultPrinter);
  setCacheValue("printers", printers);
  return printers;
}

export async function submitPrintToCups(params: {
  filePath: string;
  printer: string;
  copies: number;
  media?: string;
  pageRanges?: string;
  printScaling?: "auto" | "fit" | "fill" | "none";
  orientation?: "auto" | "portrait" | "landscape";
  sides?: "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
}) {
  const args = ["-h", config.CUPS_HOST, "-d", params.printer, "-n", String(params.copies)];

  if (params.media) {
    args.push("-o", `media=${params.media}`);
  }

  if (params.pageRanges) {
    args.push("-o", `page-ranges=${params.pageRanges}`);
  }

  if (params.printScaling && params.printScaling !== "auto") {
    args.push("-o", `print-scaling=${params.printScaling}`);
  }

  if (params.orientation === "portrait") {
    args.push("-o", "orientation-requested=3");
  } else if (params.orientation === "landscape") {
    args.push("-o", "orientation-requested=4");
  }

  if (params.sides) {
    args.push("-o", `sides=${params.sides}`);
  }

  args.push(params.filePath);

  const response = await runCommand("lp", args, {
    timeoutMs: config.PRINT_TIMEOUT_MS
  });

  const match = response.stdout.match(/request id is\s+(\S+)/i);
  if (!match) {
    throw new Error(`Unable to parse CUPS request id. Output: ${response.stdout || response.stderr}`);
  }

  return {
    cupsJobId: match[1]
  };
}

export async function listActiveCupsJobs() {
  const response = await runCommand("lpstat", ["-h", config.CUPS_HOST, "-W", "all", "-o"], {
    timeoutMs: config.PRINT_TIMEOUT_MS
  });

  const ids = response.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter((value): value is string => Boolean(value));

  return new Set(ids);
}

export async function cancelCupsJob(cupsJobId: string) {
  await runCommand("cancel", ["-h", config.CUPS_HOST, cupsJobId], {
    timeoutMs: config.PRINT_TIMEOUT_MS
  });
}
