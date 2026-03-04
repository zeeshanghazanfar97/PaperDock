import { NextResponse } from "next/server";

import { ScannerProxyError, requestScannerProxyStatus } from "@/lib/server/scanner-proxy-client";

export const runtime = "nodejs";

export async function GET() {
  try {
    const status = await requestScannerProxyStatus();
    return NextResponse.json(status);
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
