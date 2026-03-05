type AuthMode = "none" | "oidc" | "password" | "both";

type SessionSettings = {
  sessionSecret: string;
  sessionCookieName: string;
  transactionCookieName: string;
  sessionTtlSeconds: number;
};

type AuthSettings = SessionSettings & {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  issuerUrl: string;
  tokenUrl: string;
  scopes: string;
  redirectUrl?: string;
  jwksUrl?: string;
  endSessionUrl?: string;
  transactionTtlSeconds: number;
  clockSkewSeconds: number;
};

type PasswordAuthSettings = SessionSettings & {
  username: string;
  password: string;
};

type AuthConfig = {
  mode: AuthMode;
  session: SessionSettings | null;
  oidc: AuthSettings | null;
  password: PasswordAuthSettings | null;
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

function hasAnyOidcValues(): boolean {
  return Boolean(
    readEnv("OIDC_CLIENT_ID", "CLIENT_ID", "client_id") ||
      readEnv("OIDC_CLIENT_SECRET", "CLIENT_SECRET", "client_secret") ||
      readEnv("OIDC_AUTHORIZATION_URL", "AUTHORIZATION_URL", "authorization_url") ||
      readEnv("OIDC_ISSUER_URL", "ISSUER_URL", "issuer_url") ||
      readEnv("OIDC_TOKEN_URL", "TOKEN_URL", "token_url")
  );
}

function hasAnyPasswordValues(): boolean {
  return Boolean(readEnv("AUTH_USERNAME", "auth_username") || readEnv("AUTH_PASSWORD", "auth_password"));
}

function resolveAuthMode(): AuthMode {
  const configuredModeRaw = readEnv("AUTH_MODE", "auth_mode");
  if (configuredModeRaw) {
    const normalized = configuredModeRaw.toLowerCase();
    if (normalized === "none" || normalized === "oidc" || normalized === "password" || normalized === "both") {
      return normalized;
    }
    throw new Error('Invalid AUTH_MODE. Supported values: "none", "oidc", "password", "both".');
  }

  const hasOidcValues = hasAnyOidcValues();
  const hasPasswordValues = hasAnyPasswordValues();

  if (hasOidcValues && hasPasswordValues) {
    return "both";
  }

  if (hasOidcValues) {
    return "oidc";
  }

  if (hasPasswordValues) {
    return "password";
  }

  return "none";
}

function buildSessionSettings(defaultSecret?: string): SessionSettings {
  const sessionSecret = readEnv("AUTH_SESSION_SECRET", "SESSION_SECRET", "auth_session_secret") ?? defaultSecret;
  if (!sessionSecret) {
    throw new Error("AUTH_SESSION_SECRET is required for the selected auth mode.");
  }

  return {
    sessionSecret,
    sessionCookieName: readEnv("AUTH_SESSION_COOKIE_NAME", "SESSION_COOKIE_NAME", "auth_session_cookie_name") ?? "paperdock_session",
    transactionCookieName:
      readEnv("AUTH_TRANSACTION_COOKIE_NAME", "TRANSACTION_COOKIE_NAME", "auth_transaction_cookie_name") ?? "paperdock_oidc_tx",
    sessionTtlSeconds: readIntEnv(
      8 * 60 * 60,
      "AUTH_SESSION_TTL_SECONDS",
      "OIDC_SESSION_TTL_SECONDS",
      "SESSION_TTL_SECONDS",
      "session_ttl_seconds"
    )
  };
}

function buildOidcSettings(baseSession?: SessionSettings): AuthSettings {
  const clientId = readEnv("OIDC_CLIENT_ID", "CLIENT_ID", "client_id");
  const clientSecret = readEnv("OIDC_CLIENT_SECRET", "CLIENT_SECRET", "client_secret");
  const authorizationUrl = validateUrl(
    "OIDC_AUTHORIZATION_URL",
    readEnv("OIDC_AUTHORIZATION_URL", "AUTHORIZATION_URL", "authorization_url")
  );
  const issuerUrl = validateUrl("OIDC_ISSUER_URL", readEnv("OIDC_ISSUER_URL", "ISSUER_URL", "issuer_url"));
  const tokenUrl = validateUrl("OIDC_TOKEN_URL", readEnv("OIDC_TOKEN_URL", "TOKEN_URL", "token_url"));

  const requiredCount = [clientId, clientSecret, authorizationUrl, issuerUrl, tokenUrl].filter(Boolean).length;
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

  const session = baseSession ?? buildSessionSettings(clientSecret);

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
    ...session,
    transactionTtlSeconds: readIntEnv(
      10 * 60,
      "OIDC_TRANSACTION_TTL_SECONDS",
      "TRANSACTION_TTL_SECONDS",
      "transaction_ttl_seconds"
    ),
    clockSkewSeconds: readIntEnv(60, "OIDC_CLOCK_SKEW_SECONDS", "CLOCK_SKEW_SECONDS", "clock_skew_seconds")
  };
}

function buildPasswordSettings(baseSession?: SessionSettings): PasswordAuthSettings {
  const username = readEnv("AUTH_USERNAME", "auth_username");
  const password = readEnv("AUTH_PASSWORD", "auth_password");

  if (!username || !password) {
    throw new Error("Password auth requires AUTH_USERNAME and AUTH_PASSWORD.");
  }

  return {
    ...(baseSession ?? buildSessionSettings()),
    username,
    password
  };
}

export function getAuthConfig(): AuthConfig {
  const mode = resolveAuthMode();

  if (mode === "none") {
    return {
      mode,
      session: null,
      oidc: null,
      password: null
    };
  }

  if (mode === "oidc") {
    const oidc = buildOidcSettings();
    return {
      mode,
      session: oidc,
      oidc,
      password: null
    };
  }

  if (mode === "password") {
    const password = buildPasswordSettings();
    return {
      mode,
      session: password,
      oidc: null,
      password
    };
  }

  const oidcClientSecret = readEnv("OIDC_CLIENT_SECRET", "CLIENT_SECRET", "client_secret");
  const session = buildSessionSettings(oidcClientSecret);
  const oidc = buildOidcSettings(session);
  const password = buildPasswordSettings(session);

  return {
    mode,
    session,
    oidc,
    password
  };
}

export function getAuthSettings(): AuthSettings | null {
  return getAuthConfig().oidc;
}

export type { AuthConfig, AuthMode, AuthSettings, PasswordAuthSettings, SessionSettings };
