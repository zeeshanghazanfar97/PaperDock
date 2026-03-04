import { config } from "@/lib/server/config";

function buildScannerProxyUrl(pathname: string) {
  if (!config.SCANNER_PROXY_URL) {
    throw new Error("SCANNER_PROXY_URL is not configured");
  }

  const prefix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${config.SCANNER_PROXY_URL}${prefix}`;
}

function buildScannerProxySignal(params: { signal?: AbortSignal | null; timeoutMs?: number }) {
  const timeoutMs = params.timeoutMs ?? config.SCANNER_PROXY_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (!params.signal) {
    return timeoutSignal;
  }

  return AbortSignal.any([params.signal, timeoutSignal]);
}

export function isScannerProxyEnabled() {
  return Boolean(config.SCANNER_PROXY_URL);
}

export async function scannerProxyFetch(
  pathname: string,
  init: RequestInit & {
    timeoutMs?: number;
  } = {}
) {
  const url = buildScannerProxyUrl(pathname);
  const headers = new Headers(init.headers);

  if (config.SCANNER_PROXY_TOKEN) {
    headers.set("Authorization", `Bearer ${config.SCANNER_PROXY_TOKEN}`);
  }

  const signal = buildScannerProxySignal({
    signal: init.signal,
    timeoutMs: init.timeoutMs
  });

  return fetch(url, {
    ...init,
    headers,
    signal
  });
}

export async function readResponseJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      error: text
    };
  }
}
