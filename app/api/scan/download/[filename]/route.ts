import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { dataPaths } from "@/lib/server/paths";

export const runtime = "nodejs";

function contentTypeFromFilename(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".tif" || ext === ".tiff") {
    return "image/tiff";
  }
  if (ext === ".pnm" || ext === ".pbm" || ext === ".pgm" || ext === ".ppm") {
    return "image/x-portable-anymap";
  }
  return "application/octet-stream";
}

export async function GET(_: Request, { params }: { params: Promise<{ filename: string }> }) {
  bootstrapServer();

  const { filename } = await params;
  const safeFilename = path.basename(filename);

  if (safeFilename !== filename) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const scansRoot = path.resolve(dataPaths.scans);
  const filePath = path.resolve(path.join(scansRoot, safeFilename));

  if (!filePath.startsWith(`${scansRoot}${path.sep}`)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const bytes = fs.readFileSync(filePath);

  return new Response(bytes, {
    headers: {
      "Content-Type": contentTypeFromFilename(safeFilename),
      "Content-Disposition": `attachment; filename=\"${safeFilename}\"`,
      "Cache-Control": "no-store"
    }
  });
}
