type AuthSettings = {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  issuerUrl: string;
  tokenUrl: string;
  scopes: string;
  redirectUrl?: string;
  jwksUrl?: string;
  endSessionUrl?: string;
  sessionSecret: string;
  sessionCookieName: string;
  transactionCookieName: string;
  sessionTtlSeconds: number;
  transactionTtlSeconds: number;
  clockSkewSeconds: number;
};

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readIntEnv(defaultValue: number, ...keys: string[]): number {
  const raw = readEnv(...keys);
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric auth env value for ${keys[0]}`);
  }
  return parsed;
}

function validateUrl(name: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`Invalid URL for ${name}`);
  }
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function getAuthSettings(): AuthSettings | null {
  const clientId = readEnv("OIDC_CLIENT_ID", "CLIENT_ID", "client_id");
  const clientSecret = readEnv("OIDC_CLIENT_SECRET", "CLIENT_SECRET", "client_secret");
  const authorizationUrl = validateUrl(
    "OIDC_AUTHORIZATION_URL",
    readEnv("OIDC_AUTHORIZATION_URL", "AUTHORIZATION_URL", "authorization_url")
  );
  const issuerUrl = validateUrl("OIDC_ISSUER_URL", readEnv("OIDC_ISSUER_URL", "ISSUER_URL", "issuer_url"));
  const tokenUrl = validateUrl("OIDC_TOKEN_URL", readEnv("OIDC_TOKEN_URL", "TOKEN_URL", "token_url"));

  const requiredCount = [clientId, clientSecret, authorizationUrl, issuerUrl, tokenUrl].filter(Boolean).length;

  if (requiredCount === 0) {
    return null;
  }

  if (requiredCount !== 5 || !clientId || !clientSecret || !authorizationUrl || !issuerUrl || !tokenUrl) {
    throw new Error(
      "Incomplete OIDC configuration. Set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_AUTHORIZATION_URL, OIDC_ISSUER_URL, and OIDC_TOKEN_URL."
    );
  }

  const scopes = readEnv("OIDC_SCOPES", "SCOPES", "scopes") ?? "openid profile email";
  const redirectUrl = validateUrl("OIDC_REDIRECT_URL", readEnv("OIDC_REDIRECT_URL", "REDIRECT_URL", "redirect_url"));
  const jwksUrl = validateUrl("OIDC_JWKS_URL", readEnv("OIDC_JWKS_URL", "JWKS_URL", "jwks_url"));
  const endSessionUrl = validateUrl(
    "OIDC_END_SESSION_URL",
    readEnv("OIDC_END_SESSION_URL", "END_SESSION_URL", "end_session_url")
  );

  const sessionSecret = readEnv("AUTH_SESSION_SECRET", "SESSION_SECRET", "auth_session_secret") ?? clientSecret;
  const sessionCookieName = readEnv("AUTH_SESSION_COOKIE_NAME", "SESSION_COOKIE_NAME", "auth_session_cookie_name") ?? "paperdock_session";
  const transactionCookieName =
    readEnv("AUTH_TRANSACTION_COOKIE_NAME", "TRANSACTION_COOKIE_NAME", "auth_transaction_cookie_name") ?? "paperdock_oidc_tx";

  return {
    clientId,
    clientSecret,
    authorizationUrl,
    issuerUrl: normalizeIssuer(issuerUrl),
    tokenUrl,
    scopes,
    redirectUrl,
    jwksUrl,
    endSessionUrl,
    sessionSecret,
    sessionCookieName,
    transactionCookieName,
    sessionTtlSeconds: readIntEnv(8 * 60 * 60, "OIDC_SESSION_TTL_SECONDS", "SESSION_TTL_SECONDS", "session_ttl_seconds"),
    transactionTtlSeconds: readIntEnv(
      10 * 60,
      "OIDC_TRANSACTION_TTL_SECONDS",
      "TRANSACTION_TTL_SECONDS",
      "transaction_ttl_seconds"
    ),
    clockSkewSeconds: readIntEnv(60, "OIDC_CLOCK_SKEW_SECONDS", "CLOCK_SKEW_SECONDS", "clock_skew_seconds")
  };
}

export type { AuthSettings };
