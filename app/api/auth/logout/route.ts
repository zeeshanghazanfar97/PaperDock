import { NextRequest, NextResponse } from "next/server";

import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { getExternalOrigin, isSecureRequest } from "@/lib/server/auth/http";
import { resolveEndSessionUrl } from "@/lib/server/auth/oidc";
import { getAuthConfig } from "@/lib/server/auth/settings";

export const runtime = "nodejs";

function clearCookie(response: NextResponse, request: NextRequest, cookieName: string) {
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
}

async function handleLogout(request: NextRequest): Promise<NextResponse> {
  const authConfig = getAuthConfig();
  const fallbackReturnTo = authConfig.mode === "none" ? "/" : "/login";
  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo") ?? fallbackReturnTo);

  let redirectTarget = new URL(returnTo, getExternalOrigin(request)).toString();
  if (authConfig.mode === "oidc" && authConfig.oidc) {
    const settings = authConfig.oidc;
    const endSessionUrl = await resolveEndSessionUrl(settings);
    if (endSessionUrl) {
      const providerLogoutUrl = new URL(endSessionUrl);
      providerLogoutUrl.searchParams.set("post_logout_redirect_uri", redirectTarget);
      providerLogoutUrl.searchParams.set("client_id", settings.clientId);
      redirectTarget = providerLogoutUrl.toString();
    }
  }

  const response = NextResponse.redirect(redirectTarget);
  if (!authConfig.session) {
    clearCookie(response, request, "paperdock_session");
    clearCookie(response, request, "paperdock_oidc_tx");
    return response;
  }

  clearCookie(response, request, authConfig.session.sessionCookieName);
  clearCookie(response, request, authConfig.session.transactionCookieName);
  return response;
}

export async function GET(request: NextRequest) {
  return handleLogout(request);
}

export async function POST(request: NextRequest) {
  return handleLogout(request);
}
