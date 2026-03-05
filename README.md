# PaperDock

PaperDock is a self-hosted print, scan, and photocopy desk with configurable authentication modes.

Built with:
- Proxy HTTP API for printer/scanner operations.
- Next.js + shadcn/ui frontend.
- SQLite + JSONL audit logs for history.

Proxy API source of truth:
- [PaperDock-proxy repository](https://github.com/zeeshanghazanfar97/PaperDock-proxy)
- Local quick reference in this repo: [`api.md`](./api.md)

## Features

- Print section:
  - Upload PDF/JPG/JPEG/PNG and print.
  - Choose printer, copies, and print options.
  - Cancel active/submitted print jobs.

- Scan section:
  - Start single-page scan through the proxy API.
  - Progress updates via SSE (`scan_progress`).
  - Download scanned outputs and PDF exports.

- Photocopy:
  - Trigger direct scan+print from the UI (`Photocopy` button).
  - Tracks photocopy runs in print history.

- History:
  - Persisted jobs/artifacts in SQLite.
  - Append-only JSONL audit stream in `/data/logs/jobs-YYYY-MM-DD.jsonl`.

- Authentication:
  - `none`: no login required.
  - `password`: static username/password from `.env`.
  - `oidc`: OAuth2/OIDC authorization code flow with PKCE (for Authentik and compatible providers).
  - `both`: enable both `password` and `oidc`; users can sign in with either method.

## Environment

Copy `.env.example` to `.env.local` as needed.

Important defaults:
- `PROXY_API_URL=http://10.1.1.190:8000`
- `DATA_DIR=/data`

## Authentication configuration

Set `AUTH_MODE` in `.env`:
- `AUTH_MODE=none`: no authentication.
- `AUTH_MODE=password`: local static credentials.
- `AUTH_MODE=oidc`: SSO via OAuth2/OpenID Connect.
- `AUTH_MODE=both`: enable both SSO and local password login.

Shared auth/session env:
- `AUTH_SESSION_SECRET` (required for `password`, optional for `oidc`; defaults to `OIDC_CLIENT_SECRET` in oidc mode)
- `AUTH_SESSION_COOKIE_NAME` (default `paperdock_session`)
- `AUTH_TRANSACTION_COOKIE_NAME` (default `paperdock_oidc_tx`)
- `AUTH_SESSION_TTL_SECONDS` (default `28800`)

Password mode required env (`AUTH_MODE=password` or `AUTH_MODE=both`):
- `AUTH_USERNAME`
- `AUTH_PASSWORD`

OIDC mode required env (`AUTH_MODE=oidc` or `AUTH_MODE=both`):
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `OIDC_AUTHORIZATION_URL`
- `OIDC_ISSUER_URL`
- `OIDC_TOKEN_URL`

Common optional values:
- `OIDC_SCOPES` (default: `openid profile email`)
- `OIDC_REDIRECT_URL` (defaults to `https://<your-host>/api/auth/callback`)
- `OIDC_JWKS_URL` (optional override; usually discovered from issuer metadata)
- `OIDC_END_SESSION_URL` (for provider logout)
- `OIDC_TRANSACTION_TTL_SECONDS` (default `600`)
- `OIDC_CLOCK_SKEW_SECONDS` (default `60`)

Mode selection notes:
- If `AUTH_MODE` is omitted, PaperDock auto-detects mode from env values.
- If both OIDC and password env values are present and `AUTH_MODE` is omitted, auto-detection uses `both`.
- Lowercase aliases are accepted for OIDC core fields (`client_id`, `client_secret`, `authorization_url`, `issuer_url`, `token_url`, `scopes`).

## Authentik Setup

1. In Authentik, create a new `OAuth2/OpenID Provider`.
2. Set `Client type` to `Confidential`.
3. Set a redirect URI for PaperDock:
   - `https://<paperdock-domain>/api/auth/callback`
   - For local dev: `http://localhost:3000/api/auth/callback`
4. Keep token signing on RSA (default `RS256`).
5. Set scopes to include at least `openid profile email`.
6. Create an Application and assign this provider to it, then apply access policy/group assignment as needed.
7. Copy provider values into `.env`:
   - `OIDC_CLIENT_ID`: Authentik client ID
   - `OIDC_CLIENT_SECRET`: Authentik client secret
   - `OIDC_AUTHORIZATION_URL`: `https://<authentik-domain>/application/o/authorize/`
   - `OIDC_TOKEN_URL`: `https://<authentik-domain>/application/o/token/`
   - `OIDC_ISSUER_URL`: `https://<authentik-domain>/application/o/<provider-slug>/`
8. Optional: set `OIDC_END_SESSION_URL` from the provider discovery document if you want full IdP logout.

After updating env values, restart PaperDock.

## Local run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Docker run

```bash
docker compose up --build -d
```

This mounts `./data` to `/data` in the container for DB, logs, uploads, and scans.

## API endpoints

- `GET /api/health`
- `GET /api/auth/login`
- `GET /api/auth/callback`
- `POST /api/auth/password`
- `GET /api/auth/logout`
- `POST /api/auth/logout`
- `GET /api/printers`
- `GET /api/scanners`
- `POST /api/copy`
- `POST /api/scan` (scan helper endpoint)
- `GET /api/scan/status`
- `GET /api/scan/download/:filename`
- `POST /api/print/jobs`
- `GET /api/print/jobs/:jobId`
- `POST /api/print/jobs/:jobId/cancel`
- `POST /api/scan/jobs`
- `GET /api/scan/jobs/:jobId`
- `POST /api/scan/jobs/:jobId/cancel`
- `GET /api/scan/jobs/:jobId/events` (SSE)
- `GET /api/scan/jobs/:jobId/download?format=png|pdf|jpeg|tiff|pnm`
- `GET /api/jobs?type=&status=&limit=&cursor=`

## Data storage

- SQLite DB: `${DB_PATH:-./paperdock.sqlite}`
- Uploads: `${DATA_DIR}/uploads`
- Scans: `${DATA_DIR}/scans`
- JSONL logs: `${DATA_DIR}/logs`

## Notes

 - All routes except `/api/health` and `/api/auth/*` require authentication when `AUTH_MODE` is `oidc`, `password`, or `both`.
- Only one scan can run at a time.
- Retention cleanup removes expired files but keeps job metadata and audit records.
