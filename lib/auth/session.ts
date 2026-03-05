import { createSignedToken, parseSignedToken } from "@/lib/auth/signed-token";

export type UserSession = {
  sub: string;
  name?: string;
  email?: string;
  preferredUsername?: string;
  iat: number;
  exp: number;
};

export type OidcAuthTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: number;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function createSessionToken(session: UserSession, secret: string): Promise<string> {
  return createSignedToken(session, secret);
}

export async function readSessionToken(token: string, secret: string): Promise<UserSession | null> {
  const payload = await parseSignedToken(token, secret);
  if (!payload) {
    return null;
  }

  const sub = asString(payload.sub);
  const iat = asNumber(payload.iat);
  const exp = asNumber(payload.exp);
  if (!sub || iat === null || exp === null) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) {
    return null;
  }

  return {
    sub,
    name: asOptionalString(payload.name),
    email: asOptionalString(payload.email),
    preferredUsername: asOptionalString(payload.preferredUsername),
    iat,
    exp
  };
}

export async function createTransactionToken(transaction: OidcAuthTransaction, secret: string): Promise<string> {
  return createSignedToken(transaction, secret);
}

export async function readTransactionToken(token: string, secret: string): Promise<OidcAuthTransaction | null> {
  const payload = await parseSignedToken(token, secret);
  if (!payload) {
    return null;
  }

  const state = asString(payload.state);
  const nonce = asString(payload.nonce);
  const codeVerifier = asString(payload.codeVerifier);
  const returnTo = asString(payload.returnTo);
  const createdAt = asNumber(payload.createdAt);

  if (!state || !nonce || !codeVerifier || !returnTo || createdAt === null) {
    return null;
  }

  return {
    state,
    nonce,
    codeVerifier,
    returnTo,
    createdAt
  };
}
