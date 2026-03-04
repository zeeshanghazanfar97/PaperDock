# PaperDock

PaperDock is a self-hosted print, scan, and photocopy desk that gives your browser a clean, no-login interface for document workflows.

Built with:
- Proxy HTTP API for printer/scanner operations.
- Next.js + shadcn/ui frontend.
- SQLite + JSONL audit logs for history.

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

## Environment

Copy `.env.example` to `.env.local` as needed.

Important defaults:
- `PROXY_API_URL=http://10.1.1.190:8000`
- `DATA_DIR=/data`

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

- SQLite DB: `${DATA_DIR}/web-printer.sqlite`
- Uploads: `${DATA_DIR}/uploads`
- Scans: `${DATA_DIR}/scans`
- JSONL logs: `${DATA_DIR}/logs`

## Notes

- This app is intentionally no-login and open.
- Only one scan can run at a time.
- Retention cleanup removes expired files but keeps job metadata and audit records.
