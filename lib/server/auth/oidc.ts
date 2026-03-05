import { base64UrlDecodeToBytes, base64UrlDecodeToString, base64UrlEncodeBytes } from "@/lib/auth/signed-token";

import type { NextRequest } from "next/server";

import { getExternalOrigin } from "@/lib/server/auth/http";
import type { AuthSettings } from "@/lib/server/auth/settings";

const encoder = new TextEncoder();

const RSA_JWT_HASHES = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512"
} as const;

type SupportedRsaJwtAlg = keyof typeof RSA_JWT_HASHES;

type IdTokenClaims = {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
};

type OidcTokenResponse = {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

type OpenIdConfiguration = {
  issuer?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
};

let openIdConfigurationCache:
  | {
      issuer: string;
      fetchedAt: number;
      value: OpenIdConfiguration;
    }
  | null = null;

let jwksCache:
  | {
      jwksUri: string;
      fetchedAt: number;
      keys: JsonWebKey[];
    }
  | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toNumberClaim(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function jwkKid(key: JsonWebKey): string | undefined {
  const candidate = (key as Record<string, unknown>).kid;
  return typeof candidate === "string" ? candidate : undefined;
}

function isSupportedRsaAlg(value: string): value is SupportedRsaJwtAlg {
  return value in RSA_JWT_HASHES;
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseJwtSegment(value: string): Record<string, unknown> {
  const parsed = JSON.parse(base64UrlDecodeToString(value)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Invalid JWT segment payload");
  }
  return parsed;
}

function hasExpectedAudience(audClaim: string | string[], clientId: string): boolean {
  if (typeof audClaim === "string") {
    return audClaim === clientId;
  }
  return audClaim.includes(clientId);
}

function buildDiscoveryUrl(issuerUrl: string): string {
  const issuerWithTrailingSlash = issuerUrl.endsWith("/") ? issuerUrl : `${issuerUrl}/`;
  return new URL(".well-known/openid-configuration", issuerWithTrailingSlash).toString();
}

function parseTokenResponse(payload: unknown): OidcTokenResponse {
  if (!isRecord(payload)) {
    throw new Error("Token endpoint returned an invalid payload");
  }
  return payload as OidcTokenResponse;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const message =
      (isRecord(payload) && typeof payload.error_description === "string" && payload.error_description) ||
      (isRecord(payload) && typeof payload.error === "string" && payload.error) ||
      `Request failed (${response.status})`;
    throw new Error(message);
  }

  if (!isRecord(payload)) {
    throw new Error("Received invalid JSON response");
  }

  return payload;
}

async function getOpenIdConfiguration(settings: AuthSettings): Promise<OpenIdConfiguration> {
  if (openIdConfigurationCache && openIdConfigurationCache.issuer === settings.issuerUrl) {
    const ageMs = Date.now() - openIdConfigurationCache.fetchedAt;
    if (ageMs < 60 * 60 * 1000) {
      return openIdConfigurationCache.value;
    }
  }

  const payload = await fetchJson(buildDiscoveryUrl(settings.issuerUrl), { cache: "no-store" });

  const configuration: OpenIdConfiguration = {
    issuer: typeof payload.issuer === "string" ? payload.issuer : undefined,
    jwks_uri: typeof payload.jwks_uri === "string" ? payload.jwks_uri : undefined,
    end_session_endpoint: typeof payload.end_session_endpoint === "string" ? payload.end_session_endpoint : undefined
  };

  openIdConfigurationCache = {
    issuer: settings.issuerUrl,
    fetchedAt: Date.now(),
    value: configuration
  };

  return configuration;
}

async function getJwksUri(settings: AuthSettings): Promise<string> {
  if (settings.jwksUrl) {
    return settings.jwksUrl;
  }

  const discovered = await getOpenIdConfiguration(settings);
  if (!discovered.jwks_uri) {
    throw new Error("Could not resolve jwks_uri from issuer metadata");
  }

  return discovered.jwks_uri;
}

async function getJwks(settings: AuthSettings, forceRefresh = false): Promise<{ jwksUri: string; keys: JsonWebKey[] }> {
  const jwksUri = await getJwksUri(settings);

  if (!forceRefresh && jwksCache && jwksCache.jwksUri === jwksUri) {
    const ageMs = Date.now() - jwksCache.fetchedAt;
    if (ageMs < 15 * 60 * 1000) {
      return {
        jwksUri: jwksCache.jwksUri,
        keys: jwksCache.keys
      };
    }
  }

  const payload = await fetchJson(jwksUri, { cache: "no-store" });
  const keys = Array.isArray(payload.keys) ? (payload.keys.filter(isRecord) as JsonWebKey[]) : [];

  if (!keys.length) {
    throw new Error("JWKS endpoint returned no keys");
  }

  jwksCache = {
    jwksUri,
    fetchedAt: Date.now(),
    keys
  };

  return {
    jwksUri,
    keys
  };
}

async function verifyIdTokenSignature(idToken: string, settings: AuthSettings): Promise<Record<string, unknown>> {
  const segments = idToken.split(".");
  if (segments.length !== 3) {
    throw new Error("id_token format is invalid");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = parseJwtSegment(encodedHeader);
  const payload = parseJwtSegment(encodedPayload);

  const alg = toStringClaim(header.alg);
  if (!alg || !isSupportedRsaAlg(alg)) {
    throw new Error("Unsupported id_token signature algorithm");
  }

  const kid = toStringClaim(header.kid);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlDecodeToBytes(encodedSignature);
  const jwks = await getJwks(settings);

  const candidateKeys = jwks.keys.filter((key) => {
    if (key.kty !== "RSA") {
      return false;
    }
    if (key.use && key.use !== "sig") {
      return false;
    }
    if (key.alg && key.alg !== alg) {
      return false;
    }
    const keyId = jwkKid(key);
    if (kid && keyId && keyId !== kid) {
      return false;
    }
    return true;
  });

  if (!candidateKeys.length) {
    const refreshed = await getJwks(settings, true);
    return verifyIdTokenWithKeys(signingInput, signature, alg, kid, payload, refreshed.keys);
  }

  return verifyIdTokenWithKeys(signingInput, signature, alg, kid, payload, candidateKeys);
}

async function verifyIdTokenWithKeys(
  signingInput: string,
  signature: Uint8Array,
  alg: SupportedRsaJwtAlg,
  kid: string | undefined,
  payload: Record<string, unknown>,
  keys: JsonWebKey[]
): Promise<Record<string, unknown>> {
  const hash = RSA_JWT_HASHES[alg];

  for (const key of keys) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        key,
        {
          name: "RSASSA-PKCS1-v1_5",
          hash
        },
        false,
        ["verify"]
      );

      const verified = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        asArrayBuffer(signature),
        encoder.encode(signingInput)
      );
      if (verified) {
        return payload;
      }
    } catch {
      // Keep trying with other keys.
    }
  }

  if (kid) {
    throw new Error(`Unable to verify id_token signature for key id ${kid}`);
  }
  throw new Error("Unable to verify id_token signature");
}

function parseClaims(payload: Record<string, unknown>): IdTokenClaims {
  const sub = toStringClaim(payload.sub);
  const iss = toStringClaim(payload.iss);
  const audRaw = payload.aud;
  const exp = toNumberClaim(payload.exp);
  const iat = toNumberClaim(payload.iat);
  const nbf = toNumberClaim(payload.nbf);
  const nonce = toStringClaim(payload.nonce);
  const name = toStringClaim(payload.name);
  const email = toStringClaim(payload.email);
  const preferred_username = toStringClaim(payload.preferred_username);

  let aud: string | string[] | null = null;
  if (typeof audRaw === "string") {
    aud = audRaw;
  } else if (Array.isArray(audRaw) && audRaw.every((value) => typeof value === "string")) {
    aud = audRaw as string[];
  }

  if (!sub || !iss || !aud || exp === undefined) {
    throw new Error("id_token payload is missing required claims");
  }

  return {
    sub,
    iss,
    aud,
    exp,
    iat,
    nbf,
    nonce,
    name,
    email,
    preferred_username
  };
}

export function randomBase64Url(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

export async function pkceS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

export function resolveRedirectUri(settings: AuthSettings, request: NextRequest): string {
  if (settings.redirectUrl) {
    return settings.redirectUrl;
  }
  return `${getExternalOrigin(request)}/api/auth/callback`;
}

export function buildAuthorizationUrl(
  settings: AuthSettings,
  params: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }
): string {
  const url = new URL(settings.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", settings.scopes);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeAuthorizationCode(options: {
  settings: AuthSettings;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OidcTokenResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", options.code);
  body.set("redirect_uri", options.redirectUri);
  body.set("client_id", options.settings.clientId);
  body.set("client_secret", options.settings.clientSecret);
  body.set("code_verifier", options.codeVerifier);

  const responsePayload = await fetchJson(options.settings.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString(),
    cache: "no-store"
  });

  const tokenResponse = parseTokenResponse(responsePayload);
  if (!tokenResponse.id_token || typeof tokenResponse.id_token !== "string") {
    throw new Error("Token response is missing id_token");
  }

  return tokenResponse;
}

export async function verifyIdToken(options: {
  settings: AuthSettings;
  idToken: string;
  expectedNonce: string;
}): Promise<IdTokenClaims> {
  const payload = await verifyIdTokenSignature(options.idToken, options.settings);
  const claims = parseClaims(payload);

  const now = Math.floor(Date.now() / 1000);
  const skew = options.settings.clockSkewSeconds;

  if (normalizeIssuer(claims.iss) !== normalizeIssuer(options.settings.issuerUrl)) {
    throw new Error("id_token issuer mismatch");
  }

  if (!hasExpectedAudience(claims.aud, options.settings.clientId)) {
    throw new Error("id_token audience mismatch");
  }

  if (claims.exp < now - skew) {
    throw new Error("id_token has expired");
  }

  if (typeof claims.nbf === "number" && claims.nbf > now + skew) {
    throw new Error("id_token is not valid yet");
  }

  if (typeof claims.iat === "number" && claims.iat > now + skew) {
    throw new Error("id_token issued-at time is invalid");
  }

  if (claims.nonce !== options.expectedNonce) {
    throw new Error("id_token nonce mismatch");
  }

  return claims;
}

export async function resolveEndSessionUrl(settings: AuthSettings): Promise<string | null> {
  if (settings.endSessionUrl) {
    return settings.endSessionUrl;
  }

  try {
    const discovered = await getOpenIdConfiguration(settings);
    return discovered.end_session_endpoint ?? null;
  } catch {
    return null;
  }
}
