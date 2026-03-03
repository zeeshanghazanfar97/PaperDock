import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { discoverScanners } from "@/lib/server/scanner";

export const runtime = "nodejs";

export async function GET() {
  bootstrapServer();

  try {
    const scanners = await discoverScanners();
    return NextResponse.json({
      scanners,
      selectedScanner: scanners[0] ?? null
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
