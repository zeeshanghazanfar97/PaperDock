# PaperDock

PaperDock is a self-hosted print and scan desk that gives your browser a clean, no-login interface for document workflows.

Built with:
- CUPS CLI (`lp`, `lpstat`, `cancel`) for print jobs.
- SANE `scanimage` for single-page scans (local or via scanner proxy).
- Next.js + shadcn/ui frontend.
- SQLite + JSONL audit logs for history.

## Features

- Print section:
  - Upload PDF/JPG/JPEG/PNG and print.
  - Choose printer, copies, and media option.
  - Cancel active/submitted print jobs.

- Scan section:
  - Start single-page scan.
  - Live line-by-line canvas updates via SSE (`scan_rows`).
  - Progress updates via `scan_progress`.
  - Download PNG or image-only PDF on completion.
  - Supports direct scanner access or remote LAN scanner proxy.

- History:
  - Persisted jobs/artifacts in SQLite.
  - Append-only JSONL audit stream in `/data/logs/jobs-YYYY-MM-DD.jsonl`.

## Environment

Copy `.env.example` to `.env.local` as needed.

Important defaults:
- `CUPS_HOST=10.2.1.103`
- `SANE_HOST=10.2.1.103`
- `DATA_DIR=/data`
- `SCANNER_PROXY_URL=` (empty means local `scanimage`)

## Scanner proxy (recommended for Docker + LAN scanners)

If scanner discovery/execution inside Docker is unreliable, run the dedicated proxy on a Debian host with native scanner access and point PaperDock to it.

- Proxy service lives in [`proxy/README.md`](proxy/README.md)
- Set in PaperDock environment:
  - `SCANNER_PROXY_URL=http://<debian-host-ip>:3412`
  - `SCANNER_PROXY_TOKEN=<token>` (if proxy auth enabled)

When `SCANNER_PROXY_URL` is set:
- `/api/scanners` uses proxy scanner discovery
- scan jobs run through proxy streaming + result download
- print flows remain unchanged

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

To use proxy mode in Docker, also provide:

- `SCANNER_PROXY_URL`
- `SCANNER_PROXY_TOKEN` (optional)

## API endpoints

- `GET /api/health`
- `GET /api/printers`
- `GET /api/scanners`
- `POST /api/print/jobs`
- `GET /api/print/jobs/:jobId`
- `POST /api/print/jobs/:jobId/cancel`
- `POST /api/scan/jobs`
- `GET /api/scan/jobs/:jobId`
- `POST /api/scan/jobs/:jobId/cancel`
- `GET /api/scan/jobs/:jobId/events` (SSE)
- `GET /api/scan/jobs/:jobId/download?format=png|pdf`
- `GET /api/jobs?type=&status=&limit=&cursor=`

## Data storage

- SQLite DB: `${DATA_DIR}/web-printer.sqlite` (default path, kept for compatibility)
- Uploads: `${DATA_DIR}/uploads`
- Scans: `${DATA_DIR}/scans`
- JSONL logs: `${DATA_DIR}/logs`

## Notes

- This app is intentionally no-login and open.
- Only one scan can run at a time.
- Retention cleanup removes expired files but keeps job metadata and audit records.
