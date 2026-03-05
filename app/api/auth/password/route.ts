import { createHash, timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { createSessionToken } from "@/lib/auth/session";
import { getExternalOrigin, isSecureRequest } from "@/lib/server/auth/http";
import { getAuthConfig } from "@/lib/server/auth/settings";

export const runtime = "nodejs";

type PasswordRequestPayload = {
  username?: string;
  password?: string;
  returnTo?: string;
};

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secureStringEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function loginRedirect(request: NextRequest, returnTo: string, error: string): NextResponse {
  const target = new URL("/login", getExternalOrigin(request));
  target.searchParams.set("error", error);
  if (returnTo !== "/") {
    target.searchParams.set("returnTo", returnTo);
  }
  return NextResponse.redirect(target);
}

async function parsePayload(request: NextRequest): Promise<PasswordRequestPayload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return ((await request.json().catch(() => ({}))) as PasswordRequestPayload) ?? {};
  }

  const formData = await request.formData();
  return {
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
    returnTo: String(formData.get("returnTo") ?? "")
  };
}

export async function POST(request: NextRequest) {
  const authConfig = getAuthConfig();
  const payload = await parsePayload(request);
  const returnTo = sanitizeReturnTo(payload.returnTo);

  if (!authConfig.password) {
    return loginRedirect(request, returnTo, "Password login is not enabled.");
  }
  const passwordSettings = authConfig.password;

  const username = (payload.username ?? "").trim();
  const password = payload.password ?? "";

  const usernameMatches = secureStringEqual(username, passwordSettings.username);
  const passwordMatches = secureStringEqual(password, passwordSettings.password);

  if (!usernameMatches || !passwordMatches) {
    return loginRedirect(request, returnTo, "Invalid username or password.");
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionToken = await createSessionToken(
    {
      sub: `password:${passwordSettings.username}`,
      name: passwordSettings.username,
      preferredUsername: passwordSettings.username,
      iat: now,
      exp: now + passwordSettings.sessionTtlSeconds
    },
    passwordSettings.sessionSecret
  );

  const response = NextResponse.redirect(new URL(returnTo, getExternalOrigin(request)));
  response.cookies.set(passwordSettings.sessionCookieName, sessionToken, {
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: "lax",
    path: "/",
    maxAge: passwordSettings.sessionTtlSeconds
  });
  response.cookies.set(passwordSettings.transactionCookieName, "", {
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });

  return response;
}
