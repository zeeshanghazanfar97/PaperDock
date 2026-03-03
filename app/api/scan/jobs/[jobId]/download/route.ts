import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { getJob } from "@/lib/server/job-store";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  bootstrapServer();

  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job || job.type !== "scan") {
    return NextResponse.json({ error: "Scan job not found" }, { status: 404 });
  }

  const format = new URL(request.url).searchParams.get("format");
  if (format !== "png" && format !== "pdf") {
    return NextResponse.json({ error: "format must be png or pdf" }, { status: 400 });
  }

  const kind = format === "png" ? "scan_png" : "scan_pdf";
  const artifact = [...job.artifacts]
    .filter((item) => item.kind === kind && !item.deletedAt)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (!artifact) {
    return NextResponse.json({ error: `No ${format} artifact found` }, { status: 404 });
  }

  if (!fs.existsSync(artifact.path)) {
    return NextResponse.json({ error: "Artifact missing from disk" }, { status: 410 });
  }

  const body = fs.readFileSync(artifact.path);
  return new Response(body, {
    headers: {
      "Content-Type": artifact.mime,
      "Content-Disposition": `attachment; filename=\"scan-${jobId}${path.extname(artifact.path)}\"`,
      "Cache-Control": "no-store"
    }
  });
}
