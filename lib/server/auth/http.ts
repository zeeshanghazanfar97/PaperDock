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
