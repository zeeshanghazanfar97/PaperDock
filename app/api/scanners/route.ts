import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { ScannerProxyError, requestProxyScanDevices } from "@/lib/server/scanner-proxy-client";

export const runtime = "nodejs";

export async function GET() {
  bootstrapServer();

  try {
    const scanners = await requestProxyScanDevices();

    return NextResponse.json({
      scanners,
      selectedScanner: scanners[0] ?? null
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
