import { config } from "@/lib/server/config";
import { retentionCleanup, markRunningAsInterrupted } from "@/lib/server/job-store";
import { logInfo, logError } from "@/lib/server/logger";
import { ensureDataDirs } from "@/lib/server/paths";

declare global {
  // eslint-disable-next-line no-var
  var __webPrinterBootstrapped: boolean | undefined;
  // eslint-disable-next-line no-var
  var __webPrinterRetentionTimer: NodeJS.Timeout | undefined;
}

export function bootstrapServer() {
  if (global.__webPrinterBootstrapped) {
    return;
  }

  ensureDataDirs();
  markRunningAsInterrupted();

  const intervalMs = 6 * 60 * 60 * 1000;
  global.__webPrinterRetentionTimer = setInterval(() => {
    try {
      const cleaned = retentionCleanup(config.RETENTION_DAYS);
      logInfo("retention cleanup completed", { cleaned });
    } catch (error) {
      logError("retention cleanup failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, intervalMs);

  global.__webPrinterRetentionTimer.unref();

  global.__webPrinterBootstrapped = true;
  logInfo("bootstrap complete", {
    dataDir: config.DATA_DIR,
    dbPath: config.dbPath,
    retentionDays: config.RETENTION_DAYS
  });
}
