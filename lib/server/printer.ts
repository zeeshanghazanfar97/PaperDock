import { config } from "@/lib/server/config";
import { getCacheValue, setCacheValue } from "@/lib/server/job-store";
import {
  requestProxyCancelPrintJob,
  requestProxyPrintJob,
  requestProxyPrintJobs,
  requestProxyPrinters,
  type OptionValue
} from "@/lib/server/scanner-proxy-client";

export interface PrinterInfo {
  name: string;
  state: string;
  isDefault: boolean;
}

function timeoutSecondsFromMs(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return Math.max(5, Math.min(3600, seconds));
}

export async function discoverPrinters(): Promise<PrinterInfo[]> {
  const cached = getCacheValue<PrinterInfo[]>("printers");

  if (cached && Date.now() - cached.updatedAt < 15_000) {
    return cached.value;
  }

  const response = await requestProxyPrinters();
  const printers = response.printers.map((printer) => ({
    name: printer.name,
    state: printer.state,
    isDefault: printer.isDefault
  }));

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
  const options: Record<string, OptionValue> = {};

  if (params.media) {
    options.media = params.media;
  }

  if (params.printScaling && params.printScaling !== "auto") {
    options["print-scaling"] = params.printScaling;
  }

  if (params.orientation === "portrait") {
    options["orientation-requested"] = 3;
  } else if (params.orientation === "landscape") {
    options["orientation-requested"] = 4;
  }

  if (params.sides) {
    options.sides = params.sides;
  }

  const result = await requestProxyPrintJob({
    file_path: params.filePath,
    printer: params.printer,
    copies: params.copies,
    page_ranges: params.pageRanges ?? null,
    options,
    timeout_seconds: timeoutSecondsFromMs(config.PRINT_TIMEOUT_MS)
  });

  return {
    cupsJobId: result.job_id
  };
}

export async function listActiveCupsJobs() {
  const response = await requestProxyPrintJobs();
  return response.ids;
}

export async function cancelCupsJob(cupsJobId: string) {
  await requestProxyCancelPrintJob(cupsJobId);
}
