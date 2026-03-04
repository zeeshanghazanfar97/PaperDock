# PaperDock Scanner Proxy

PaperDock Scanner Proxy is a small LAN service that runs natively on a Debian host with direct scanner access and exposes scanning over HTTP.

PaperDock (running inside Docker) connects to this proxy for:
- scanner discovery
- live scan progress + preview rows
- final PNG/PDF result download

## Why this exists

`scanimage` network backend discovery from inside containers can be unreliable on some LAN setups. Running scanner access natively on the Debian host avoids that and gives PaperDock a stable endpoint.

## Endpoints

- `GET /health`
- `GET /scanners?refresh=1`
- `POST /scan/stream` (NDJSON event stream)
- `GET /scan/results/:sessionId?format=png|pdf`

If `PROXY_TOKEN` is set, all endpoints except `/health` require:

`Authorization: Bearer <PROXY_TOKEN>`

## Request/response for `POST /scan/stream`

Request JSON:

```json
{
  "dpi": 150,
  "mode": "Color",
  "scannerDeviceId": "hpaio:/usb/...",
  "rowChunk": 32,
  "previewMaxWidth": 900,
  "previewMaxHeight": 1400
}
```

Streamed NDJSON events (`application/x-ndjson`):

- `{"type":"scan_header","payload":{...}}`
- `{"type":"scan_rows","payload":{...}}`
- `{"type":"scan_progress","payload":{"percent":42}}`
- `{"type":"scan_complete","payload":{"sessionId":"...", ...}}`
- `{"type":"scan_error","payload":{"message":"..."}}`

## Environment

Copy `.env.example` to `.env` and adjust values:

- `PROXY_HOST` default `0.0.0.0`
- `PROXY_PORT` default `3412`
- `PROXY_DATA_DIR` default `./data`
- `PROXY_TOKEN` optional auth token
- `SCAN_TIMEOUT_MS` scan timeout
- `SCAN_LIST_TIMEOUT_MS` `scanimage -L` timeout
- `SCAN_ROW_CHUNK` preview chunking
- `SCAN_PREVIEW_MAX_WIDTH`, `SCAN_PREVIEW_MAX_HEIGHT` preview downsampling bounds
- `RESULT_TTL_MS` how long result files remain downloadable

## Native Debian Deployment

### 1) Install prerequisites

```bash
sudo apt-get update
sudo apt-get install -y sane-utils build-essential
```

### 2) Validate scanner access on host

```bash
scanimage -L
```

You should see entries like:

```text
device `net:10.2.1.103:hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=...` is a Hewlett-Packard ...
device `hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=...` is a Hewlett-Packard ...
```

### 3) Run proxy

```bash
cd proxy
cp .env.example .env
npm install
npm run start
```

### 4) Optional systemd service

```bash
sudo cp proxy/paperdock-scanner-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperdock-scanner-proxy
sudo systemctl status paperdock-scanner-proxy
```

Adjust `User`, `Group`, `WorkingDirectory`, and `EnvironmentFile` in the unit file for your host.

## Docker Deployment

```bash
cd proxy
docker compose up --build -d
```

This exposes port `3412` and persists proxy output under `proxy/data`.

## PaperDock integration

In PaperDock app environment:

- `SCANNER_PROXY_URL=http://<debian-host-ip>:3412`
- `SCANNER_PROXY_TOKEN=<PROXY_TOKEN>` (if token enabled)

Once set, PaperDock scan flows use the proxy automatically.

## Notes

- This service currently supports one scan stream per request and is stateless across process restarts except generated files in `PROXY_DATA_DIR`.
- Expired result files are cleaned by TTL.
