import fs from "node:fs";
import path from "node:path";

import { config } from "@/lib/server/config";

export const dataPaths = {
  root: config.DATA_DIR,
  uploads: path.join(config.DATA_DIR, "uploads"),
  scans: path.join(config.DATA_DIR, "scans"),
  logs: path.join(config.DATA_DIR, "logs"),
  tmp: path.join(config.DATA_DIR, "tmp")
};

export function ensureDataDirs() {
  for (const dir of Object.values(dataPaths)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function safeFileName(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
