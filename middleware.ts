import { NextRequest, NextResponse } from "next/server";

import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { readSessionToken } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/server/auth/settings";

const PUBLIC_ROUTE_PATHS = new Set(["/login", "/favicon.ico", "/robots.txt", "/sitemap.xml"]);
const PUBLIC_ROUTE_PREFIXES = ["/_next/", "/api/auth/"];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_ROUTE_PATHS.has(pathname)) {
    return true;
  }

  if (pathname === "/api/health") {
    return true;
  }

  return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function loginUrl(request: NextRequest): URL {
  const url = new URL("/login", request.url);
  const returnTo = sanitizeReturnTo(`${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (returnTo !== "/") {
    url.searchParams.set("returnTo", returnTo);
  }
  return url;
}

function unauthorizedApiResponse(request: NextRequest): NextResponse {
  const login = loginUrl(request);
  return NextResponse.json(
    {
      error: "Authentication required",
      loginUrl: `${login.pathname}${login.search}`
    },
    { status: 401 }
  );
}

async function isValidSession(request: NextRequest): Promise<boolean> {
  const settings = getAuthSettings();
  if (!settings) {
    return true;
  }

  const token = request.cookies.get(settings.sessionCookieName)?.value;
  if (!token) {
    return false;
  }

  const session = await readSessionToken(token, settings.sessionSecret);
  return Boolean(session);
}

export async function middleware(request: NextRequest) {
  const settings = getAuthSettings();
  if (!settings) {
    return NextResponse.next();
  }

  if (isPublicPath(request.nextUrl.pathname)) {
    if (request.nextUrl.pathname === "/login") {
      const valid = await isValidSession(request);
      if (valid) {
        return NextResponse.redirect(new URL("/", request.url));
      }
    }

    return NextResponse.next();
  }

  const valid = await isValidSession(request);
  if (valid) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return unauthorizedApiResponse(request);
  }

  return NextResponse.redirect(loginUrl(request));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"]
};
