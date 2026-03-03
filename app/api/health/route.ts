import { NextResponse } from "next/server";

import { sqlite } from "@/lib/server/db";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { runCommand } from "@/lib/server/commands";

export const runtime = "nodejs";

export async function GET() {
  bootstrapServer();

  try {
    sqlite.prepare("SELECT 1 as ok").get();

    const [lpResult, scanResult] = await Promise.all([
      runCommand("which", ["lpstat"]),
      runCommand("which", ["scanimage"])
    ]);

    return NextResponse.json({
      ok: true,
      dependencies: {
        lpstat: lpResult.stdout.trim(),
        scanimage: scanResult.stdout.trim()
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
