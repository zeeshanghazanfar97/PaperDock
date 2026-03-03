import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { getJob } from "@/lib/server/job-store";
import { cancelPrintJob } from "@/lib/server/print-manager";

export const runtime = "nodejs";

export async function POST(_: Request, { params }: { params: Promise<{ jobId: string }> }) {
  bootstrapServer();

  const { jobId } = await params;

  try {
    await cancelPrintJob(jobId);
    return NextResponse.json({ job: getJob(jobId) });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 400 }
    );
  }
}
