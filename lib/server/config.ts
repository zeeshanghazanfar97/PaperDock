import path from "node:path";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PROXY_API_URL: z.string().url().optional(),
  SCANNER_PROXY_URL: z.string().url().optional(),
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
const proxyApiUrl = env.PROXY_API_URL ?? env.SCANNER_PROXY_URL ?? "http://10.1.1.190:8000";
const dbPath = env.DB_PATH?.trim() || "/paperdock.sqlite";

export const config = {
  ...env,
  PROXY_API_URL: proxyApiUrl,
  SCANNER_PROXY_URL: proxyApiUrl,
  DATA_DIR: dataDir,
  dbPath
};
