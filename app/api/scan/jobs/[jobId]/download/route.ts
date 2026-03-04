import fs from "node:fs";

import { NextResponse } from "next/server";

import { PDFDocument } from "pdf-lib";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { getJob } from "@/lib/server/job-store";

export const runtime = "nodejs";

const supportedFormats = new Set(["png", "pdf", "jpeg", "tiff", "pnm"]);

type ScanDownloadFormat = "png" | "pdf" | "jpeg" | "tiff" | "pnm";
type ScanArtifactKind = "scan_png" | "scan_pdf" | "scan_jpeg" | "scan_tiff" | "scan_pnm";

function kindForFormat(format: ScanDownloadFormat): ScanArtifactKind {
  if (format === "png") {
    return "scan_png";
  }
  if (format === "pdf") {
    return "scan_pdf";
  }
  if (format === "jpeg") {
    return "scan_jpeg";
  }
  if (format === "tiff") {
    return "scan_tiff";
  }
  return "scan_pnm";
}

function formatForKind(kind: string): ScanDownloadFormat | null {
  if (kind === "scan_png") {
    return "png";
  }
  if (kind === "scan_pdf") {
    return "pdf";
  }
  if (kind === "scan_jpeg") {
    return "jpeg";
  }
  if (kind === "scan_tiff") {
    return "tiff";
  }
  if (kind === "scan_pnm") {
    return "pnm";
  }
  return null;
}

function contentTypeForFormat(format: ScanDownloadFormat) {
  if (format === "png") {
    return "image/png";
  }
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "tiff") {
    return "image/tiff";
  }
  if (format === "pnm") {
    return "image/x-portable-anymap";
  }
  return "application/pdf";
}

function mapFileExtension(format: ScanDownloadFormat) {
  if (format === "jpeg") {
    return "jpg";
  }
  return format;
}

function latestArtifactByKind(job: NonNullable<ReturnType<typeof getJob>>, kind: ScanArtifactKind) {
  return [...job.artifacts]
    .filter((artifact) => artifact.kind === kind && !artifact.deletedAt)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function resolveSourceArtifactForPdf(job: NonNullable<ReturnType<typeof getJob>>) {
  const order: ScanArtifactKind[] = ["scan_png", "scan_jpeg", "scan_tiff", "scan_pnm"];

  for (const kind of order) {
    const artifact = latestArtifactByKind(job, kind);
    if (artifact) {
      return {
        artifact,
        format: formatForKind(kind)
      };
    }
  }

  return null;
}

async function createPdfFromImage(imageBytes: Uint8Array, imageFormat: "png" | "jpeg", dpi: number) {
  const safeDpi = Math.max(75, dpi);
  const pdf = await PDFDocument.create();
  const embedded = imageFormat === "png" ? await pdf.embedPng(imageBytes) : await pdf.embedJpg(imageBytes);

  const widthPt = (embedded.width * 72) / safeDpi;
  const heightPt = (embedded.height * 72) / safeDpi;

  const page = pdf.addPage([widthPt, heightPt]);
  page.drawImage(embedded, {
    x: 0,
    y: 0,
    width: widthPt,
    height: heightPt
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  bootstrapServer();

  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job || job.type !== "scan") {
    return NextResponse.json({ error: "Scan job not found" }, { status: 404 });
  }

  const formatParam = new URL(request.url).searchParams.get("format");
  if (!formatParam || !supportedFormats.has(formatParam)) {
    return NextResponse.json({ error: "format must be one of png, pdf, jpeg, tiff, pnm" }, { status: 400 });
  }

  const format = formatParam as ScanDownloadFormat;

  if (format === "pdf") {
    const existingPdf = latestArtifactByKind(job, "scan_pdf");
    if (existingPdf) {
      if (!fs.existsSync(existingPdf.path)) {
        return NextResponse.json({ error: "Artifact missing from disk" }, { status: 410 });
      }

      const body = fs.readFileSync(existingPdf.path);
      return new Response(body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename=\"scan-${jobId}.pdf\"`,
          "Cache-Control": "no-store"
        }
      });
    }

    const source = resolveSourceArtifactForPdf(job);
    if (!source || !source.format) {
      return NextResponse.json({ error: "No scan source available to generate PDF" }, { status: 404 });
    }

    if (source.format !== "png" && source.format !== "jpeg") {
      return NextResponse.json({ error: `Cannot generate PDF from ${source.format}` }, { status: 400 });
    }

    if (!fs.existsSync(source.artifact.path)) {
      return NextResponse.json({ error: "Artifact missing from disk" }, { status: 410 });
    }

    const sourceBytes = fs.readFileSync(source.artifact.path);
    const dpi =
      typeof job.meta.dpi === "number"
        ? job.meta.dpi
        : typeof job.meta.requestedDpi === "number"
          ? job.meta.requestedDpi
          : 150;

    const pdfBytes = await createPdfFromImage(sourceBytes, source.format, dpi);

    return new Response(pdfBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=\"scan-${jobId}.pdf\"`,
        "Cache-Control": "no-store"
      }
    });
  }

  const kind = kindForFormat(format);
  const artifact = latestArtifactByKind(job, kind);

  if (!artifact) {
    const sourceFormat = typeof job.meta.outputFormat === "string" ? job.meta.outputFormat : "unknown";
    return NextResponse.json(
      {
        error: `Requested ${format} is not available for this scan (source format: ${sourceFormat})`
      },
      { status: 400 }
    );
  }

  if (!fs.existsSync(artifact.path)) {
    return NextResponse.json({ error: "Artifact missing from disk" }, { status: 410 });
  }

  const body = fs.readFileSync(artifact.path);

  return new Response(body, {
    headers: {
      "Content-Type": artifact.mime || contentTypeForFormat(format),
      "Content-Disposition": `attachment; filename=\"scan-${jobId}.${mapFileExtension(format)}\"`,
      "Cache-Control": "no-store"
    }
  });
}
