import { NextResponse } from "next/server";
import { z } from "zod";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { listJobs } from "@/lib/server/job-store";

export const runtime = "nodejs";

const querySchema = z.object({
  type: z.enum(["print", "scan"]).optional(),
  status: z.enum(["queued", "running", "submitted", "completed", "failed", "canceled", "interrupted"]).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.coerce.number().int().positive().optional()
});

export async function GET(request: Request) {
  bootstrapServer();

  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = querySchema.safeParse(params);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = listJobs(parsed.data);
  return NextResponse.json(result);
}
