import type { NextRequest } from "next/server";

import { sanitizeReturnTo } from "@/lib/auth/return-to";

export function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",").some((value) => value.trim().toLowerCase() === "https");
  }

  if (request.nextUrl.protocol === "https:") {
    return true;
  }

  return process.env.NODE_ENV === "production";
}

export function requestedReturnTo(request: NextRequest): string {
  return sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo"));
}

function forwardedHeaderValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const first = value
    .split(",")
    .map((segment) => segment.trim())
    .find((segment) => segment.length > 0);

  return first ?? null;
}

export function getExternalOrigin(request: NextRequest): string {
  const forwardedProto = forwardedHeaderValue(request.headers.get("x-forwarded-proto"));
  const forwardedHost = forwardedHeaderValue(request.headers.get("x-forwarded-host"));

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}
