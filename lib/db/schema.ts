import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["print", "scan"] }).notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  startedAt: integer("started_at", { mode: "number" }),
  finishedAt: integer("finished_at", { mode: "number" }),
  errorMessage: text("error_message"),
  metaJson: text("meta_json").notNull().default("{}")
});

export const jobEvents = sqliteTable("job_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull(),
  ts: integer("ts", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}")
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  kind: text("kind").notNull(),
  path: text("path").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "number" })
});

export const settingsCache = sqliteTable("settings_cache", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull()
});
