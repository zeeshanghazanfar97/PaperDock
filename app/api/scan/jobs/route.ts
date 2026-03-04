import { NextResponse } from "next/server";
import { z } from "zod";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { canStartNewScanJob, createJob, getJob } from "@/lib/server/job-store";
import { isScanRunning, startScanJob } from "@/lib/server/scan-manager";

export const runtime = "nodejs";

const requestSchema = z.object({
  dpi: z.number().int().min(75).max(600).default(150),
  mode: z.enum(["Color", "Gray"]).default("Color"),
  scannerDeviceId: z.string().trim().min(1).max(256).optional()
});

export async function POST(request: Request) {
  bootstrapServer();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (isScanRunning() || !canStartNewScanJob()) {
    return NextResponse.json({ error: "A scan job is already active" }, { status: 409 });
  }

  const job = createJob({
    type: "scan",
    status: "queued",
    meta: {
      requestedDpi: parsed.data.dpi,
      requestedMode: parsed.data.mode,
      requestedScannerDeviceId: parsed.data.scannerDeviceId ?? null
    }
  });

  void startScanJob(job.id, {
    dpi: parsed.data.dpi,
    mode: parsed.data.mode,
    scannerDeviceId: parsed.data.scannerDeviceId
  }).catch(() => {
    // errors are handled and persisted inside the manager
  });

  return NextResponse.json({ job: getJob(job.id) }, { status: 202 });
}
