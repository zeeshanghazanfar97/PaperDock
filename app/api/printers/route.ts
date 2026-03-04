import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { discoverPrinters } from "@/lib/server/printer";
import { ScannerProxyError } from "@/lib/server/scanner-proxy-client";

export const runtime = "nodejs";

export async function GET() {
  bootstrapServer();

  try {
    const printers = await discoverPrinters();
    return NextResponse.json({
      printers,
      defaultPrinter: printers.find((printer) => printer.isDefault)?.name ?? printers[0]?.name ?? null
    });
  } catch (error) {
    const statusCode = error instanceof ScannerProxyError ? 502 : 500;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: statusCode }
    );
  }
}
