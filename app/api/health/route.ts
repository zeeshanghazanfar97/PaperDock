import { NextResponse } from "next/server";

import { sqlite } from "@/lib/server/db";
import { bootstrapServer } from "@/lib/server/bootstrap";
import {
  ScannerProxyError,
  requestProxyHealth,
  requestProxyPrinters,
  requestProxyScanDevices
} from "@/lib/server/scanner-proxy-client";
import { config } from "@/lib/server/config";

export const runtime = "nodejs";

export async function GET() {
  bootstrapServer();

  try {
    sqlite.prepare("SELECT 1 as ok").get();

    const [proxyHealth, printers, scanners] = await Promise.all([
      requestProxyHealth(),
      requestProxyPrinters(),
      requestProxyScanDevices()
    ]);

    return NextResponse.json({
      ok: true,
      dependencies: {
        proxyApiUrl: config.PROXY_API_URL,
        proxyStatus: proxyHealth.status,
        printers: printers.printers.length,
        scanners: scanners.length
      }
    });
  } catch (error) {
    const statusCode = error instanceof ScannerProxyError ? 502 : 500;
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: statusCode }
    );
  }
}
