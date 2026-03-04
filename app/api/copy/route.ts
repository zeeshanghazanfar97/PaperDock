import { NextResponse } from "next/server";
import { z } from "zod";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { config } from "@/lib/server/config";
import { appendJobEvent, createJob, getJob, updateJobStatus } from "@/lib/server/job-store";
import { trackSubmittedPrintJob } from "@/lib/server/print-manager";
import { discoverPrinters } from "@/lib/server/printer";
import {
  ScannerProxyError,
  requestProxyCopy,
  type OptionValue
} from "@/lib/server/scanner-proxy-client";

export const runtime = "nodejs";

const requestSchema = z.object({
  device: z.string().min(1).optional(),
  dpi: z.number().int().min(75).max(600).default(150),
  mode: z.enum(["Color", "Gray", "Lineart"]).default("Color"),
  printer: z.string().min(1).optional(),
  copies: z.number().int().min(1).max(99).default(1),
  media: z.string().trim().max(64).optional(),
  printScaling: z.enum(["auto", "fit", "fill", "none"]).default("auto"),
  orientation: z.enum(["auto", "portrait", "landscape"]).default("auto"),
  sides: z.enum(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]).default("one-sided")
});

function timeoutSecondsFromMs(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return Math.max(5, Math.min(3600, seconds));
}

export async function POST(request: Request) {
  bootstrapServer();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let printers: Awaited<ReturnType<typeof discoverPrinters>>;
  try {
    printers = await discoverPrinters();
  } catch (error) {
    const status = error instanceof ScannerProxyError ? 502 : 500;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status }
    );
  }
  if (!printers.length) {
    return NextResponse.json({ error: "No printers available" }, { status: 503 });
  }

  const defaultPrinter = printers.find((printer) => printer.isDefault)?.name ?? printers[0].name;
  const printer = parsed.data.printer ?? defaultPrinter;

  if (!printers.some((candidate) => candidate.name === printer)) {
    return NextResponse.json({ error: `Printer not found: ${printer}` }, { status: 400 });
  }

  const job = createJob({
    type: "print",
    status: "queued",
    meta: {
      operation: "copy",
      printer,
      device: parsed.data.device ?? null,
      copies: parsed.data.copies,
      dpi: parsed.data.dpi,
      mode: parsed.data.mode,
      media: parsed.data.media ?? null,
      printScaling: parsed.data.printScaling,
      orientation: parsed.data.orientation,
      sides: parsed.data.sides
    }
  });

  updateJobStatus({
    jobId: job.id,
    status: "running"
  });

  appendJobEvent({
    jobId: job.id,
    eventType: "copy_started",
    payload: {
      printer,
      device: parsed.data.device ?? null,
      copies: parsed.data.copies,
      dpi: parsed.data.dpi,
      mode: parsed.data.mode
    }
  });

  try {
    const printOptions: Record<string, OptionValue> = {
      sides: parsed.data.sides
    };

    if (parsed.data.media) {
      printOptions.media = parsed.data.media;
    }

    if (parsed.data.printScaling !== "auto") {
      printOptions["print-scaling"] = parsed.data.printScaling;
    }

    if (parsed.data.orientation === "portrait") {
      printOptions["orientation-requested"] = 3;
    } else if (parsed.data.orientation === "landscape") {
      printOptions["orientation-requested"] = 4;
    }

    const proxy = await requestProxyCopy({
      scan: {
        device: parsed.data.device ?? null,
        resolution: parsed.data.dpi,
        mode: parsed.data.mode,
        format: "png"
      },
      print_settings: {
        printer,
        copies: parsed.data.copies,
        options: printOptions,
        timeout_seconds: timeoutSecondsFromMs(config.PRINT_TIMEOUT_MS)
      },
      delete_scanned_file: true
    });

    const printJobId = proxy.print.job_id ?? null;

    if (printJobId) {
      updateJobStatus({
        jobId: job.id,
        status: "submitted",
        metaPatch: {
          printJobId
        }
      });

      appendJobEvent({
        jobId: job.id,
        eventType: "copy_submitted",
        payload: {
          printJobId,
          scannedFileDeleted: proxy.scanned_file_deleted ?? null
        }
      });

      trackSubmittedPrintJob(job.id, printJobId);
    } else {
      updateJobStatus({
        jobId: job.id,
        status: "completed"
      });

      appendJobEvent({
        jobId: job.id,
        eventType: "copy_completed_untracked",
        payload: {
          scannedFileDeleted: proxy.scanned_file_deleted ?? null
        }
      });
    }

    return NextResponse.json({
      job: getJob(job.id),
      proxy
    });
  } catch (error) {
    const message =
      error instanceof ScannerProxyError
        ? `Proxy API (${error.status}): ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);

    updateJobStatus({
      jobId: job.id,
      status: "failed",
      errorMessage: message
    });

    appendJobEvent({
      jobId: job.id,
      eventType: "copy_failed",
      payload: {
        error: message
      }
    });

    const status = error instanceof ScannerProxyError ? (error.status >= 500 ? 502 : error.status) : 500;

    return NextResponse.json(
      {
        error: message,
        job: getJob(job.id)
      },
      { status }
    );
  }
}
