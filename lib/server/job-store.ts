import crypto from "node:crypto";
import fs from "node:fs";

import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { artifacts, jobEvents, jobs, settingsCache } from "@/lib/db/schema";
import { db } from "@/lib/server/db";
import { appendAudit } from "@/lib/server/audit-log";
import { logError } from "@/lib/server/logger";
import { nowMs } from "@/lib/server/time";
import type { JobRecord, JobStatus, JobType } from "@/lib/types/jobs";

function parseJsonSafe<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function createJob(params: {
  id?: string;
  type: JobType;
  status?: JobStatus;
  meta?: Record<string, unknown>;
}) {
  const id = params.id ?? crypto.randomUUID();
  const createdAt = nowMs();
  const status = params.status ?? "queued";
  const meta = params.meta ?? {};

  db.insert(jobs).values({
    id,
    type: params.type,
    status,
    createdAt,
    metaJson: JSON.stringify(meta)
  }).run();

  appendJobEvent({
    jobId: id,
    eventType: "job_created",
    payload: { type: params.type, status, meta }
  });

  const created = getJob(id);
  if (!created) {
    throw new Error(`Failed to load created job: ${id}`);
  }

  return created;
}

export function appendJobEvent(params: {
  jobId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  const ts = nowMs();
  const payload = params.payload ?? {};

  db.insert(jobEvents).values({
    jobId: params.jobId,
    eventType: params.eventType,
    payloadJson: JSON.stringify(payload),
    ts
  }).run();

  const job = db.select().from(jobs).where(eq(jobs.id, params.jobId)).get();
  if (job) {
    appendAudit({
      ts: new Date(ts).toISOString(),
      job_id: job.id,
      type: job.type,
      status: job.status,
      event: params.eventType,
      payload
    });
  }
}

export function updateJobStatus(params: {
  jobId: string;
  status: JobStatus;
  errorMessage?: string | null;
  metaPatch?: Record<string, unknown>;
}) {
  const row = db.select().from(jobs).where(eq(jobs.id, params.jobId)).get();

  if (!row) {
    throw new Error(`Job not found: ${params.jobId}`);
  }

  const nextMeta = {
    ...parseJsonSafe<Record<string, unknown>>(row.metaJson, {}),
    ...(params.metaPatch ?? {})
  };

  const updatePayload: Record<string, unknown> = {
    status: params.status,
    metaJson: JSON.stringify(nextMeta)
  };

  if (params.status === "running" && !row.startedAt) {
    updatePayload.startedAt = nowMs();
  }

  if (["completed", "failed", "canceled", "interrupted"].includes(params.status)) {
    updatePayload.finishedAt = nowMs();
  }

  if (typeof params.errorMessage !== "undefined") {
    updatePayload.errorMessage = params.errorMessage;
  }

  db.update(jobs).set(updatePayload).where(eq(jobs.id, params.jobId)).run();

  appendJobEvent({
    jobId: params.jobId,
    eventType: "job_status_changed",
    payload: {
      from: row.status,
      to: params.status,
      error: params.errorMessage ?? null,
      metaPatch: params.metaPatch ?? {}
    }
  });

  return getJob(params.jobId);
}

export function addArtifact(params: {
  jobId: string;
  kind: "upload" | "scan_png" | "scan_pdf";
  path: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}) {
  const id = crypto.randomUUID();
  const createdAt = nowMs();

  db.insert(artifacts).values({
    id,
    jobId: params.jobId,
    kind: params.kind,
    path: params.path,
    mime: params.mime,
    sizeBytes: params.sizeBytes,
    sha256: params.sha256,
    createdAt
  }).run();

  appendJobEvent({
    jobId: params.jobId,
    eventType: "artifact_added",
    payload: {
      id,
      kind: params.kind,
      path: params.path,
      mime: params.mime,
      sizeBytes: params.sizeBytes
    }
  });

  return id;
}

export function getJob(jobId: string) {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row) {
    return null;
  }

  const item: JobRecord = {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    errorMessage: row.errorMessage ?? null,
    meta: parseJsonSafe<Record<string, unknown>>(row.metaJson, {})
  };

  const artifactRows = db.select().from(artifacts).where(eq(artifacts.jobId, jobId)).all();

  return {
    ...item,
    artifacts: artifactRows.map((artifact) => ({
      id: artifact.id,
      jobId: artifact.jobId,
      kind: artifact.kind,
      path: artifact.path,
      mime: artifact.mime,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      createdAt: artifact.createdAt,
      deletedAt: artifact.deletedAt ?? null
    }))
  };
}

export function listJobs(params: {
  type?: JobType;
  status?: JobStatus;
  limit?: number;
  cursor?: number;
}) {
  const limit = Math.max(1, Math.min(100, params.limit ?? 25));

  const filters: Array<ReturnType<typeof eq> | ReturnType<typeof lt>> = [];

  if (params.type) {
    filters.push(eq(jobs.type, params.type));
  }

  if (params.status) {
    filters.push(eq(jobs.status, params.status));
  }

  if (params.cursor) {
    filters.push(lt(jobs.createdAt, params.cursor));
  }

  const whereClause = filters.length ? and(...filters) : undefined;

  const rows = whereClause
    ? db.select().from(jobs).where(whereClause).orderBy(desc(jobs.createdAt)).limit(limit).all()
    : db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit).all();

  const jobIds = rows.map((row) => row.id);

  const artifactRows = jobIds.length
    ? db.select().from(artifacts).where(inArray(artifacts.jobId, jobIds)).all()
    : [];

  const artifactMap = new Map<string, typeof artifactRows>();
  for (const artifact of artifactRows) {
    const current = artifactMap.get(artifact.jobId) ?? [];
    current.push(artifact);
    artifactMap.set(artifact.jobId, current);
  }

  const items = rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorMessage: row.errorMessage,
    meta: parseJsonSafe<Record<string, unknown>>(row.metaJson, {}),
    artifacts: (artifactMap.get(row.id) ?? []).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      mime: artifact.mime,
      sizeBytes: artifact.sizeBytes,
      createdAt: artifact.createdAt,
      deletedAt: artifact.deletedAt,
      path: artifact.path
    }))
  }));

  return {
    items,
    nextCursor: rows.length ? rows[rows.length - 1]?.createdAt : null
  };
}

export function markRunningAsInterrupted() {
  const rows = db
    .select()
    .from(jobs)
    .where(or(eq(jobs.status, "running"), eq(jobs.status, "queued"), eq(jobs.status, "submitted")))
    .all();

  for (const row of rows) {
    try {
      db.update(jobs)
        .set({
          status: "interrupted",
          finishedAt: nowMs(),
          errorMessage: "Job interrupted by service restart"
        })
        .where(eq(jobs.id, row.id))
        .run();

      appendJobEvent({
        jobId: row.id,
        eventType: "job_interrupted_on_startup",
        payload: { previousStatus: row.status }
      });
    } catch (error) {
      logError("failed to mark interrupted job", {
        jobId: row.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function retentionCleanup(retentionDays: number) {
  const cutoff = nowMs() - retentionDays * 24 * 60 * 60 * 1000;

  const expiredArtifacts = db
    .select()
    .from(artifacts)
    .where(and(isNull(artifacts.deletedAt), lt(artifacts.createdAt, cutoff)))
    .all();

  for (const artifact of expiredArtifacts) {
    try {
      if (fs.existsSync(artifact.path)) {
        fs.unlinkSync(artifact.path);
      }
      db.update(artifacts).set({ deletedAt: nowMs() }).where(eq(artifacts.id, artifact.id)).run();

      appendJobEvent({
        jobId: artifact.jobId,
        eventType: "artifact_expired",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          path: artifact.path
        }
      });
    } catch (error) {
      logError("artifact cleanup failed", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return expiredArtifacts.length;
}

export function setCacheValue(key: string, value: unknown) {
  const payload = JSON.stringify(value);
  const ts = nowMs();

  db.insert(settingsCache)
    .values({ key, valueJson: payload, updatedAt: ts })
    .onConflictDoUpdate({
      target: settingsCache.key,
      set: {
        valueJson: payload,
        updatedAt: ts
      }
    })
    .run();
}

export function getCacheValue<T>(key: string): { value: T; updatedAt: number } | null {
  const row = db.select().from(settingsCache).where(eq(settingsCache.key, key)).get();
  if (!row) {
    return null;
  }

  return {
    value: parseJsonSafe<T>(row.valueJson, {} as T),
    updatedAt: row.updatedAt
  };
}

export function canStartNewScanJob() {
  const active = db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(and(eq(jobs.type, "scan"), or(eq(jobs.status, "running"), eq(jobs.status, "queued"), eq(jobs.status, "submitted"))))
    .get();

  return (active?.count ?? 0) === 0;
}
