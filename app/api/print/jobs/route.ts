import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";
import { z } from "zod";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { config } from "@/lib/server/config";
import { isAllowedUpload } from "@/lib/server/file-types";
import { sha256File } from "@/lib/server/hash";
import { addArtifact, createJob, getJob } from "@/lib/server/job-store";
import { dataPaths, safeFileName } from "@/lib/server/paths";
import { startPrintJob } from "@/lib/server/print-manager";
import { discoverPrinters } from "@/lib/server/printer";
import { ScannerProxyError } from "@/lib/server/scanner-proxy-client";

export const runtime = "nodejs";

const fieldsSchema = z.object({
  printer: z.string().min(1).optional(),
  copies: z.coerce.number().int().positive().max(99).default(1),
  media: z.string().trim().max(64).optional(),
  pageRanges: z.string().trim().max(128).optional(),
  printScaling: z.enum(["auto", "fit", "fill", "none"]).default("auto"),
  orientation: z.enum(["auto", "portrait", "landscape"]).default("auto"),
  sides: z.enum(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]).default("one-sided")
});

function isPdfFile(fileName: string, mimeType: string) {
  return mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
}

function isValidPageRanges(value: string) {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) {
    return false;
  }

  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(normalized)) {
    return false;
  }

  return normalized.split(",").every((segment) => {
    const [startRaw, endRaw] = segment.split("-");
    const start = Number(startRaw);
    const end = endRaw ? Number(endRaw) : start;
    return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start;
  });
}

export async function POST(request: Request) {
  bootstrapServer();

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (!isAllowedUpload(file.name, file.type)) {
    return NextResponse.json({ error: "Only PDF, PNG, JPG, and JPEG are supported" }, { status: 400 });
  }

  if (file.size <= 0) {
    return NextResponse.json({ error: "Uploaded file is empty" }, { status: 400 });
  }

  const maxUploadBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
  if (file.size > maxUploadBytes) {
    return NextResponse.json({ error: `File exceeds ${config.MAX_UPLOAD_MB}MB limit` }, { status: 413 });
  }

  const parsedFields = fieldsSchema.safeParse({
    printer: formData.get("printer")?.toString(),
    copies: formData.get("copies")?.toString() ?? "1",
    media: formData.get("media")?.toString(),
    pageRanges: formData.get("pageRanges")?.toString(),
    printScaling: formData.get("printScaling")?.toString() ?? "auto",
    orientation: formData.get("orientation")?.toString() ?? "auto",
    sides: formData.get("sides")?.toString() ?? "one-sided"
  });

  if (!parsedFields.success) {
    return NextResponse.json({ error: parsedFields.error.flatten() }, { status: 400 });
  }

  let printers: Awaited<ReturnType<typeof discoverPrinters>>;
  try {
    printers = await discoverPrinters();
  } catch (error) {
    const statusCode = error instanceof ScannerProxyError ? 502 : 500;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: statusCode }
    );
  }
  if (!printers.length) {
    return NextResponse.json({ error: "No printers available" }, { status: 503 });
  }

  const defaultPrinter = printers.find((printer) => printer.isDefault)?.name ?? printers[0].name;
  const printer = parsedFields.data.printer ?? defaultPrinter;
  const isPdf = isPdfFile(file.name, file.type);
  const pageRanges = parsedFields.data.pageRanges?.replace(/\s+/g, "");

  if (!printers.some((candidate) => candidate.name === printer)) {
    return NextResponse.json({ error: `Printer not found: ${printer}` }, { status: 400 });
  }

  if (pageRanges && !isPdf) {
    return NextResponse.json({ error: "Page range selection is only supported for PDF uploads" }, { status: 400 });
  }

  if (pageRanges && !isValidPageRanges(pageRanges)) {
    return NextResponse.json({ error: "Invalid page range format. Use forms like 2 or 1-3,5,8-10" }, { status: 400 });
  }

  const ext = path.extname(file.name).toLowerCase();
  const fileId = crypto.randomUUID();
  const safeName = safeFileName(path.basename(file.name, ext)) || "upload";
  const savedPath = path.join(dataPaths.uploads, `${fileId}-${safeName}${ext}`);

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(savedPath, buffer);

  const job = createJob({
    type: "print",
    status: "queued",
    meta: {
      fileName: file.name,
      fileMime: file.type,
      printer,
      copies: parsedFields.data.copies,
      media: parsedFields.data.media ?? null,
      pageRanges: pageRanges ?? null,
      printScaling: parsedFields.data.printScaling,
      orientation: parsedFields.data.orientation,
      sides: parsedFields.data.sides
    }
  });

  addArtifact({
    jobId: job.id,
    kind: "upload",
    path: savedPath,
    mime: file.type || "application/octet-stream",
    sizeBytes: buffer.byteLength,
    sha256: sha256File(savedPath)
  });

  try {
    await startPrintJob(job.id, {
      filePath: savedPath,
      printer,
      copies: parsedFields.data.copies,
      media: parsedFields.data.media,
      pageRanges,
      printScaling: parsedFields.data.printScaling,
      orientation: parsedFields.data.orientation,
      sides: parsedFields.data.sides
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        job: getJob(job.id)
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ job: getJob(job.id) }, { status: 201 });
}
