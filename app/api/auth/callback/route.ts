import { NextRequest, NextResponse } from "next/server";

import { createSessionToken, readTransactionToken } from "@/lib/auth/session";
import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { isSecureRequest } from "@/lib/server/auth/http";
import { exchangeAuthorizationCode, resolveRedirectUri, verifyIdToken } from "@/lib/server/auth/oidc";
import { getAuthSettings } from "@/lib/server/auth/settings";

export const runtime = "nodejs";

function redirectToLogin(request: NextRequest, message: string, returnTo = "/"): NextResponse {
  const url = new URL("/login", request.url);
  url.searchParams.set("error", message);
  const safeReturnTo = sanitizeReturnTo(returnTo);
  if (safeReturnTo !== "/") {
    url.searchParams.set("returnTo", safeReturnTo);
  }
  return NextResponse.redirect(url);
}

function clearTransactionCookie(response: NextResponse, request: NextRequest, cookieName: string) {
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
}

export async function GET(request: NextRequest) {
  const settings = getAuthSettings();
  if (!settings) {
    return redirectToLogin(request, "OIDC is not configured.");
  }

  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError) {
    const providerErrorDescription =
      request.nextUrl.searchParams.get("error_description") ?? request.nextUrl.searchParams.get("error_reason");
    return redirectToLogin(request, providerErrorDescription ?? providerError);
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) {
    return redirectToLogin(request, "Missing authorization code.");
  }

  const transactionTokenRaw = request.cookies.get(settings.transactionCookieName)?.value;
  if (!transactionTokenRaw) {
    return redirectToLogin(request, "Authentication session is missing.");
  }

  try {
    const transaction = await readTransactionToken(transactionTokenRaw, settings.sessionSecret);
    if (!transaction) {
      return redirectToLogin(request, "Authentication session is invalid.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (now - transaction.createdAt > settings.transactionTtlSeconds) {
      return redirectToLogin(request, "Authentication session has expired.", transaction.returnTo);
    }

    if (transaction.state !== state) {
      return redirectToLogin(request, "State validation failed.", transaction.returnTo);
    }

    const redirectUri = resolveRedirectUri(settings, request.nextUrl);
    const tokenResponse = await exchangeAuthorizationCode({
      settings,
      code,
      codeVerifier: transaction.codeVerifier,
      redirectUri
    });

    const claims = await verifyIdToken({
      settings,
      idToken: tokenResponse.id_token as string,
      expectedNonce: transaction.nonce
    });

    const expiresAt = Math.min(claims.exp, now + settings.sessionTtlSeconds);
    if (expiresAt <= now) {
      return redirectToLogin(request, "Authentication session expired.", transaction.returnTo);
    }

    const sessionToken = await createSessionToken(
      {
        sub: claims.sub,
        name: claims.name,
        email: claims.email,
        preferredUsername: claims.preferred_username,
        iat: now,
        exp: expiresAt
      },
      settings.sessionSecret
    );

    const returnTo = sanitizeReturnTo(transaction.returnTo);
    const response = NextResponse.redirect(new URL(returnTo, request.url));
    response.cookies.set(settings.sessionCookieName, sessionToken, {
      httpOnly: true,
      secure: isSecureRequest(request),
      sameSite: "lax",
      path: "/",
      maxAge: Math.max(1, expiresAt - now)
    });
    clearTransactionCookie(response, request, settings.transactionCookieName);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authentication failed";
    const response = redirectToLogin(request, message);
    clearTransactionCookie(response, request, settings.transactionCookieName);
    return response;
  }
}
