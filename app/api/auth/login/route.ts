import { NextRequest, NextResponse } from "next/server";

import { createTransactionToken } from "@/lib/auth/session";
import { getExternalOrigin, requestedReturnTo, isSecureRequest } from "@/lib/server/auth/http";
import { buildAuthorizationUrl, pkceS256Challenge, randomBase64Url, resolveRedirectUri } from "@/lib/server/auth/oidc";
import { getAuthConfig } from "@/lib/server/auth/settings";

export const runtime = "nodejs";

function redirectToLoginWithError(request: NextRequest, message: string, returnTo: string): NextResponse {
  const url = new URL("/login", getExternalOrigin(request));
  url.searchParams.set("error", message);
  if (returnTo !== "/") {
    url.searchParams.set("returnTo", returnTo);
  }
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const returnTo = requestedReturnTo(request);
  const authConfig = getAuthConfig();

  if (authConfig.mode === "none") {
    return NextResponse.redirect(new URL(returnTo, getExternalOrigin(request)));
  }

  if (!authConfig.oidc) {
    return redirectToLoginWithError(request, "SSO login is not enabled.", returnTo);
  }

  try {
    const settings = authConfig.oidc;
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = await pkceS256Challenge(codeVerifier);
    const redirectUri = resolveRedirectUri(settings, request);

    const transactionToken = await createTransactionToken(
      {
        state,
        nonce,
        codeVerifier,
        returnTo,
        createdAt: Math.floor(Date.now() / 1000)
      },
      settings.sessionSecret
    );

    const authorizationUrl = buildAuthorizationUrl(settings, {
      state,
      nonce,
      codeChallenge,
      redirectUri
    });

    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(settings.transactionCookieName, transactionToken, {
      httpOnly: true,
      secure: isSecureRequest(request),
      sameSite: "lax",
      path: "/",
      maxAge: settings.transactionTtlSeconds
    });

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start login";
    return redirectToLoginWithError(request, message, returnTo);
  }
}
