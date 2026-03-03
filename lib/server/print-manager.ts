import { config } from "@/lib/server/config";
import { appendJobEvent, getJob, updateJobStatus } from "@/lib/server/job-store";
import { logError, logInfo } from "@/lib/server/logger";
import { cancelCupsJob, listActiveCupsJobs, submitPrintToCups } from "@/lib/server/printer";

interface PrintOptions {
  filePath: string;
  printer: string;
  copies: number;
  media?: string;
  pageRanges?: string;
  printScaling?: "auto" | "fit" | "fill" | "none";
  orientation?: "auto" | "portrait" | "landscape";
  sides?: "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function watchPrintCompletion(jobId: string, cupsJobId: string) {
  const started = Date.now();

  while (Date.now() - started < config.PRINT_WATCH_TIMEOUT_MS) {
    const job = getJob(jobId);
    if (!job) {
      return;
    }

    if (["failed", "canceled", "completed", "interrupted"].includes(job.status)) {
      return;
    }

    const activeJobs = await listActiveCupsJobs();
    if (!activeJobs.has(cupsJobId)) {
      updateJobStatus({ jobId, status: "completed" });
      appendJobEvent({
        jobId,
        eventType: "print_completed",
        payload: {
          cupsJobId
        }
      });
      return;
    }

    await sleep(4_000);
  }

  updateJobStatus({
    jobId,
    status: "failed",
    errorMessage: `Timed out waiting for CUPS job ${cupsJobId} to finish`
  });

  appendJobEvent({
    jobId,
    eventType: "print_timeout",
    payload: {
      cupsJobId,
      timeoutMs: config.PRINT_WATCH_TIMEOUT_MS
    }
  });
}

export async function startPrintJob(jobId: string, options: PrintOptions) {
  updateJobStatus({
    jobId,
    status: "running",
    metaPatch: {
      printer: options.printer,
      copies: options.copies,
      media: options.media ?? null,
      pageRanges: options.pageRanges ?? null,
      printScaling: options.printScaling ?? "auto",
      orientation: options.orientation ?? "auto",
      sides: options.sides ?? "one-sided"
    }
  });

  appendJobEvent({
    jobId,
    eventType: "print_started",
    payload: {
      printer: options.printer,
      copies: options.copies,
      media: options.media ?? null,
      pageRanges: options.pageRanges ?? null,
      printScaling: options.printScaling ?? "auto",
      orientation: options.orientation ?? "auto",
      sides: options.sides ?? "one-sided"
    }
  });

  try {
    const submitted = await submitPrintToCups({
      filePath: options.filePath,
      printer: options.printer,
      copies: options.copies,
      media: options.media,
      pageRanges: options.pageRanges,
      printScaling: options.printScaling,
      orientation: options.orientation,
      sides: options.sides
    });

    updateJobStatus({
      jobId,
      status: "submitted",
      metaPatch: {
        cupsJobId: submitted.cupsJobId
      }
    });

    appendJobEvent({
      jobId,
      eventType: "print_submitted",
      payload: {
        cupsJobId: submitted.cupsJobId
      }
    });

    logInfo("print submitted", {
      jobId,
      printer: options.printer,
      cupsJobId: submitted.cupsJobId
    });

    void watchPrintCompletion(jobId, submitted.cupsJobId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      updateJobStatus({
        jobId,
        status: "failed",
        errorMessage: message
      });

      appendJobEvent({
        jobId,
        eventType: "print_watch_failed",
        payload: { error: message }
      });

      logError("print watcher failed", { jobId, error: message });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    updateJobStatus({
      jobId,
      status: "failed",
      errorMessage: message
    });

    appendJobEvent({
      jobId,
      eventType: "print_failed",
      payload: { error: message }
    });

    logError("print failed", {
      jobId,
      error: message
    });

    throw error;
  }
}

export async function cancelPrintJob(jobId: string) {
  const job = getJob(jobId);

  if (!job) {
    throw new Error("Job not found");
  }

  const cupsJobId = typeof job.meta.cupsJobId === "string" ? job.meta.cupsJobId : null;

  if (!cupsJobId) {
    throw new Error("CUPS job id missing, cannot cancel");
  }

  await cancelCupsJob(cupsJobId);

  updateJobStatus({
    jobId,
    status: "canceled",
    errorMessage: "Print canceled by user"
  });

  appendJobEvent({
    jobId,
    eventType: "print_canceled",
    payload: {
      cupsJobId
    }
  });
}
