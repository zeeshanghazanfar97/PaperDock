import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";
import { z } from "zod";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { dataPaths } from "@/lib/server/paths";
import {
  ScannerProxyError,
  requestProxyScan,
  type ScannerProxyOutputFormat
} from "@/lib/server/scanner-proxy-client";

export const runtime = "nodejs";

const requestSchema = z.object({
  resolution: z.number().int().min(75).max(600).default(150),
  color_mode: z.enum(["Color", "Gray", "Lineart"]).default("Color"),
  output_format: z.enum(["png", "jpeg", "tiff", "pnm"]).default("png")
});

function extensionForFormat(format: ScannerProxyOutputFormat) {
  if (format === "jpeg") {
    return "jpg";
  }
  return format;
}

function contentTypeForFormat(format: ScannerProxyOutputFormat) {
  if (format === "png") {
    return "image/png";
  }
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "tiff") {
    return "image/tiff";
  }
  return "image/x-portable-anymap";
}

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

  const format = parsed.data.output_format;

  try {
    const result = await requestProxyScan({
      resolution: parsed.data.resolution,
      mode: parsed.data.color_mode,
      format,
      return_base64: true
    });

    if (result.batch_mode) {
      return NextResponse.json({ error: "Batch scans are not supported" }, { status: 400 });
    }

    if (!result.base64_data) {
      return NextResponse.json({ error: "Proxy scan did not return file data" }, { status: 502 });
    }

    const bytes = Buffer.from(result.base64_data, "base64");
    if (!bytes.byteLength) {
      return NextResponse.json({ error: "Scanned file is empty" }, { status: 502 });
    }

    const filename = `scan-${Date.now()}-${crypto.randomUUID()}.${extensionForFormat(format)}`;
    const outputPath = path.join(dataPaths.scans, filename);
    fs.writeFileSync(outputPath, bytes);

    return NextResponse.json({
      ok: true,
      filename,
      output_format: format,
      content_type: contentTypeForFormat(format),
      size_bytes: bytes.byteLength,
      download_url: `/api/scan/download/${encodeURIComponent(filename)}`
    });
  } catch (error) {
    if (error instanceof ScannerProxyError) {
      return NextResponse.json({ error: error.message }, { status: error.status >= 500 ? 502 : error.status });
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
