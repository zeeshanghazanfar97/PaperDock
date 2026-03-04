import path from "node:path";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CUPS_HOST: z.string().default("10.2.1.103"),
  SANE_HOST: z.string().default("10.2.1.103"),
  DATA_DIR: z.string().optional(),
  DB_PATH: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(20),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  SCAN_ROW_CHUNK: z.coerce.number().int().positive().default(32),
  SCAN_PREVIEW_MAX_WIDTH: z.coerce.number().int().positive().default(900),
  SCAN_PREVIEW_MAX_HEIGHT: z.coerce.number().int().positive().default(1400),
  SCAN_TIMEOUT_MS: z.coerce.number().int().positive().default(8 * 60 * 1000),
  PRINT_TIMEOUT_MS: z.coerce.number().int().positive().default(45 * 1000),
  PRINT_WATCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  PORT: z.coerce.number().int().positive().default(3000)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment: ${parsed.error.message}`);
}

const env = parsed.data;
const dataDir = env.DATA_DIR ?? path.join(process.cwd(), "data");

export const config = {
  ...env,
  DATA_DIR: dataDir,
  dbPath: env.DB_PATH ?? path.join(dataDir, "web-printer.sqlite")
};
