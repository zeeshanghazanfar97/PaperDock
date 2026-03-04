import { NextResponse } from "next/server";

import { config } from "@/lib/server/config";
import { sqlite } from "@/lib/server/db";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { runCommand } from "@/lib/server/commands";
import { isScannerProxyEnabled, readResponseJson, scannerProxyFetch } from "@/lib/server/scanner-proxy";

export const runtime = "nodejs";

export async function GET() {
  bootstrapServer();

  try {
    sqlite.prepare("SELECT 1 as ok").get();

    const lpResult = await runCommand("which", ["lpstat"]);

    if (isScannerProxyEnabled()) {
      const proxyHealthResponse = await scannerProxyFetch("/health", {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        timeoutMs: config.SCANNER_PROXY_TIMEOUT_MS
      });
      const proxyHealth = await readResponseJson(proxyHealthResponse);

      if (!proxyHealthResponse.ok) {
        throw new Error(
          typeof proxyHealth.error === "string"
            ? `scanner proxy unhealthy: ${proxyHealth.error}`
            : `scanner proxy unhealthy with status ${proxyHealthResponse.status}`
        );
      }

      return NextResponse.json({
        ok: true,
        dependencies: {
          lpstat: lpResult.stdout.trim(),
          scannerProxy: config.SCANNER_PROXY_URL
        },
        scannerProxyHealth: proxyHealth
      });
    }

    const scanResult = await runCommand("which", ["scanimage"]);

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
