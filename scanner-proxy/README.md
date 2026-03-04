# PaperDock Scanner Proxy (Host Service)

This service runs directly on a Debian host (not in Docker) and exposes USB scanner access over HTTP for PaperDock.

## Endpoints

- `POST /scan`
- `GET /scan/download/{filename}`
- `GET /status`
- `GET /docs` (FastAPI Swagger UI)

`POST /scan` body:

```json
{
  "resolution": 150,
  "color_mode": "Color",
  "output_format": "png"
}
```

Allowed values:
- `color_mode`: `Color`, `Gray`, `Lineart`
- `output_format`: `png`, `jpeg`, `tiff`, `pnm`, `pdf`

## Debian Setup (systemd)

Install dependencies:

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv sane-utils
```

Create service user and directories:

```bash
sudo useradd --system --create-home --home-dir /opt/paperdock --shell /usr/sbin/nologin paperdock
sudo usermod -aG scanner,lp paperdock
sudo mkdir -p /opt/paperdock/scanner-proxy /var/lib/paperdock-scanner/tmp
sudo chown -R paperdock:paperdock /opt/paperdock /var/lib/paperdock-scanner
```

Copy service files from this repo:

```bash
sudo rsync -a --delete scanner-proxy/ /opt/paperdock/scanner-proxy/
```

Create virtualenv and install Python deps:

```bash
sudo -u paperdock python3 -m venv /opt/paperdock/scanner-proxy/.venv
sudo -u paperdock /opt/paperdock/scanner-proxy/.venv/bin/pip install --upgrade pip
sudo -u paperdock /opt/paperdock/scanner-proxy/.venv/bin/pip install -r /opt/paperdock/scanner-proxy/requirements.txt
```

Install systemd unit:

```bash
sudo cp /opt/paperdock/scanner-proxy/systemd/paperdock-scanner-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paperdock-scanner-proxy
```

Check:

```bash
systemctl status paperdock-scanner-proxy --no-pager
curl -s http://127.0.0.1:3001/status
```

The service listens on `0.0.0.0:3001`.

## Environment Variables

- `SCANNER_OUTPUT_DIR` (default `/tmp/paperdock-scans`)
- `SCAN_TIMEOUT_SECONDS` (default `180`)
- `SCAN_FILE_TTL_SECONDS` (default `3600`)
- `SCAN_DEVICE` (optional scanner device id from `scanimage -L`)

## Quick API test

```bash
curl -s -X POST http://127.0.0.1:3001/scan \
  -H 'content-type: application/json' \
  -d '{"resolution":150,"color_mode":"Color","output_format":"png"}'
```

Use returned `filename` with:

```bash
curl -LO "http://127.0.0.1:3001/scan/download/<filename>"
```
