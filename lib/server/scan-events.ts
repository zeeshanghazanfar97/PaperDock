import type { SseJobEvent } from "@/lib/types/jobs";

type Subscriber = (event: SseJobEvent) => void;

interface ScanSnapshot {
  header?: SseJobEvent;
  progress?: SseJobEvent;
  completion?: SseJobEvent;
  error?: SseJobEvent;
}

class ScanEventHub {
  private subscribers = new Map<string, Set<Subscriber>>();
  private snapshots = new Map<string, ScanSnapshot>();

  publish(jobId: string, event: SseJobEvent) {
    const snapshot = this.snapshots.get(jobId) ?? {};

    if (event.type === "scan_header") {
      snapshot.header = event;
    }

    if (event.type === "scan_progress") {
      snapshot.progress = event;
    }

    if (event.type === "scan_complete") {
      snapshot.completion = event;
    }

    if (event.type === "scan_error") {
      snapshot.error = event;
    }

    this.snapshots.set(jobId, snapshot);

    const listeners = this.subscribers.get(jobId);
    if (!listeners) {
      return;
    }

    const failedListeners: Subscriber[] = [];

    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        failedListeners.push(listener);
      }
    }

    if (failedListeners.length) {
      for (const listener of failedListeners) {
        listeners.delete(listener);
      }

      if (!listeners.size) {
        this.subscribers.delete(jobId);
      }
    }
  }

  subscribe(jobId: string, listener: Subscriber) {
    const listeners = this.subscribers.get(jobId) ?? new Set<Subscriber>();
    listeners.add(listener);
    this.subscribers.set(jobId, listeners);

    return () => {
      const existing = this.subscribers.get(jobId);
      if (!existing) {
        return;
      }
      existing.delete(listener);
      if (!existing.size) {
        this.subscribers.delete(jobId);
      }
    };
  }

  getSnapshot(jobId: string): SseJobEvent[] {
    const snapshot = this.snapshots.get(jobId);
    if (!snapshot) {
      return [];
    }

    const events = [] as SseJobEvent[];

    if (snapshot.header) {
      events.push(snapshot.header);
    }

    if (snapshot.progress) {
      events.push(snapshot.progress);
    }

    if (snapshot.completion) {
      events.push(snapshot.completion);
    }

    if (snapshot.error) {
      events.push(snapshot.error);
    }

    return events;
  }

  clear(jobId: string) {
    this.subscribers.delete(jobId);
    this.snapshots.delete(jobId);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __scanEventHub: ScanEventHub | undefined;
}

export const scanEventHub = global.__scanEventHub ?? new ScanEventHub();

if (process.env.NODE_ENV !== "production") {
  global.__scanEventHub = scanEventHub;
}
