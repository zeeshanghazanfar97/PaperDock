import { NextResponse } from "next/server";

import { bootstrapServer } from "@/lib/server/bootstrap";
import { getJob } from "@/lib/server/job-store";
import { scanEventHub } from "@/lib/server/scan-events";
import type { SseJobEvent } from "@/lib/types/jobs";

export const runtime = "nodejs";

const encoder = new TextEncoder();

function sseChunk(event: SseJobEvent["type"] | "ping", payload: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  bootstrapServer();

  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job || job.type !== "scan") {
    return NextResponse.json({ error: "Scan job not found" }, { status: 404 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      let abortHandler: (() => void) | null = null;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(chunk);
        } catch {
          closeStream();
        }
      };

      const closeStream = () => {
        if (closed) {
          return;
        }
        closed = true;
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) {
          request.signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      safeEnqueue(encoder.encode(": connected\n\n"));

      const snapshot = scanEventHub.getSnapshot(jobId);
      for (const event of snapshot) {
        safeEnqueue(sseChunk(event.type, event.payload));
      }

      unsubscribe = scanEventHub.subscribe(jobId, (event) => {
        safeEnqueue(sseChunk(event.type, event.payload));
      });

      pingTimer = setInterval(() => {
        safeEnqueue(sseChunk("ping", { ts: Date.now() }));
      }, 10_000);

      abortHandler = () => closeStream();
      request.signal.addEventListener("abort", abortHandler);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive"
    }
  });
}
