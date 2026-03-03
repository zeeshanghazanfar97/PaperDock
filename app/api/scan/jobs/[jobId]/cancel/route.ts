import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { getJob } from "@/lib/server/job-store";
import { cancelScanJob } from "@/lib/server/scan-manager";

export const runtime = "nodejs";

export async function POST(_: Request, { params }: { params: Promise<{ jobId: string }> }) {
  bootstrapServer();

  const { jobId } = await params;
  const canceled = cancelScanJob(jobId);

  if (!canceled) {
    return NextResponse.json({ error: "No active scan process for this job" }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    job: getJob(jobId)
  });
}
