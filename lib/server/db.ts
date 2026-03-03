import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "@/lib/db/schema";
import { config } from "@/lib/server/config";

function createDb() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const sqlite = new Database(config.dbPath);
  sqlite.pragma("journal_mode = WAL");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error_message TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings_cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status);
    CREATE INDEX IF NOT EXISTS idx_events_job_ts ON job_events(job_id, ts);
    CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id);
  `);

  return {
    sqlite,
    db: drizzle(sqlite, { schema })
  };
}

type DbContainer = ReturnType<typeof createDb>;

declare global {
  // eslint-disable-next-line no-var
  var __webPrinterDb: DbContainer | undefined;
}

export const dbContainer = global.__webPrinterDb ?? createDb();

if (process.env.NODE_ENV !== "production") {
  global.__webPrinterDb = dbContainer;
}

export const db = dbContainer.db;
export const sqlite = dbContainer.sqlite;
