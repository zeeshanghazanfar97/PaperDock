import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { discoverScanners } from "@/lib/server/scanner";

export const runtime = "nodejs";

export async function GET(request: Request) {
  bootstrapServer();

  try {
    const { searchParams } = new URL(request.url);
    const refresh = searchParams.get("refresh");
    const forceRefresh = refresh === "1" || refresh === "true";

    const scanners = await discoverScanners({ forceRefresh });
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
