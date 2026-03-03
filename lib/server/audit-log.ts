import fs from "node:fs";
import path from "node:path";

import { dataPaths } from "@/lib/server/paths";

interface AuditRecord {
  ts: string;
  job_id: string;
  type: string;
  status: string;
  event: string;
  payload: Record<string, unknown>;
}

export function appendAudit(record: AuditRecord) {
  const date = record.ts.slice(0, 10);
  const file = path.join(dataPaths.logs, `jobs-${date}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}
