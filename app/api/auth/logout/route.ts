import { NextRequest, NextResponse } from "next/server";

import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { isSecureRequest } from "@/lib/server/auth/http";
import { resolveEndSessionUrl } from "@/lib/server/auth/oidc";
import { getAuthSettings } from "@/lib/server/auth/settings";

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
  const settings = getAuthSettings();
  const fallbackReturnTo = settings ? "/login" : "/";
  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo") ?? fallbackReturnTo);

  let redirectTarget = new URL(returnTo, request.url).toString();
  if (settings) {
    const endSessionUrl = await resolveEndSessionUrl(settings);
    if (endSessionUrl) {
      const providerLogoutUrl = new URL(endSessionUrl);
      providerLogoutUrl.searchParams.set("post_logout_redirect_uri", redirectTarget);
      providerLogoutUrl.searchParams.set("client_id", settings.clientId);
      redirectTarget = providerLogoutUrl.toString();
    }
  }

  const response = NextResponse.redirect(redirectTarget);
  clearCookie(response, request, settings?.sessionCookieName ?? "paperdock_session");
  clearCookie(response, request, settings?.transactionCookieName ?? "paperdock_oidc_tx");
  return response;
}

export async function GET(request: NextRequest) {
  return handleLogout(request);
}

export async function POST(request: NextRequest) {
  return handleLogout(request);
}
