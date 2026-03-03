import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { getJob } from "@/lib/server/job-store";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ jobId: string }> }) {
  bootstrapServer();

  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job || job.type !== "print") {
    return NextResponse.json({ error: "Print job not found" }, { status: 404 });
  }

  return NextResponse.json({ job });
}
