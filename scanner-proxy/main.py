from __future__ import annotations

import asyncio
import mimetypes
import os
import re
import time
import uuid
from io import BytesIO
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel, Field

ColorMode = Literal["Color", "Gray", "Lineart"]
OutputFormat = Literal["png", "jpeg", "tiff", "pnm", "pdf"]


def _env_int(name: str, default: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        parsed = int(raw_value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


SCANNER_OUTPUT_DIR = Path(os.getenv("SCANNER_OUTPUT_DIR", "/tmp/paperdock-scans")).resolve()
SCAN_TIMEOUT_SECONDS = _env_int("SCAN_TIMEOUT_SECONDS", 180)
SCAN_FILE_TTL_SECONDS = _env_int("SCAN_FILE_TTL_SECONDS", 3600)
SCAN_DEVICE = os.getenv("SCAN_DEVICE")

SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

app = FastAPI(
    title="PaperDock Scanner Proxy",
    description="FastAPI wrapper around scanimage for host-based USB scanner access.",
    version="1.0.0",
)


class ScannerInfo(BaseModel):
    device_id: str
    description: str


class ScanRequest(BaseModel):
    resolution: int = Field(default=150, ge=75, le=1200)
    color_mode: ColorMode = "Color"
    output_format: OutputFormat = "png"


class ScanResponse(BaseModel):
    ok: bool = True
    filename: str
    output_format: OutputFormat
    content_type: str
    size_bytes: int
    download_url: str


class StatusResponse(BaseModel):
    ok: bool
    scanner_reachable: bool
    scanners: list[ScannerInfo]
    message: str | None = None


@app.on_event("startup")
async def _startup() -> None:
    SCANNER_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


async def _run_scanimage(args: list[str]) -> tuple[int, bytes, str]:
    process = await asyncio.create_subprocess_exec(
        "scanimage",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr_bytes = await asyncio.wait_for(process.communicate(), timeout=SCAN_TIMEOUT_SECONDS)
    except TimeoutError as error:
        process.kill()
        await process.communicate()
        raise HTTPException(status_code=504, detail=f"scanimage timed out after {SCAN_TIMEOUT_SECONDS}s") from error

    stderr = stderr_bytes.decode("utf-8", errors="replace").strip()
    code = process.returncode if process.returncode is not None else -1
    return code, stdout, stderr


def _parse_scanners(raw_output: str) -> list[ScannerInfo]:
    scanners: list[ScannerInfo] = []

    for line in raw_output.splitlines():
        cleaned = line.strip()
        if not cleaned.lower().startswith("device "):
            continue

        quoted = re.match(r"^device\s+[`'\"](.+?)[`'\"]\s+is\s+(.+)$", cleaned, flags=re.IGNORECASE)
        if quoted:
            scanners.append(ScannerInfo(device_id=quoted.group(1), description=quoted.group(2)))
            continue

        unquoted = re.match(r"^device\s+(\S+)\s+is\s+(.+)$", cleaned, flags=re.IGNORECASE)
        if unquoted:
            scanners.append(ScannerInfo(device_id=unquoted.group(1), description=unquoted.group(2)))

    return scanners


async def _discover_scanners() -> tuple[list[ScannerInfo], int, str]:
    code, stdout, stderr = await _run_scanimage(["-L"])
    decoded_stdout = stdout.decode("utf-8", errors="replace")
    scanners = _parse_scanners("\n".join(part for part in [decoded_stdout, stderr] if part))
    return scanners, code, stderr or decoded_stdout


def _cleanup_stale_files() -> None:
    ttl_seconds = SCAN_FILE_TTL_SECONDS
    if ttl_seconds <= 0:
        return

    cutoff = time.time() - ttl_seconds
    for file_path in SCANNER_OUTPUT_DIR.glob("scan-*"):
        if not file_path.is_file():
            continue
        try:
            if file_path.stat().st_mtime < cutoff:
                file_path.unlink(missing_ok=True)
        except OSError:
            continue


def _convert_scan_bytes(raw_scan: bytes, output_format: OutputFormat, resolution: int) -> tuple[bytes, str, str]:
    if output_format == "pnm":
        return raw_scan, "pnm", "image/x-portable-anymap"

    image = Image.open(BytesIO(raw_scan))
    image.load()

    buffer = BytesIO()

    if output_format == "pdf":
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        if image.mode == "L":
            image = image.convert("RGB")
        image.save(buffer, format="PDF", resolution=float(resolution))
        return buffer.getvalue(), "pdf", "application/pdf"

    if output_format == "jpeg":
        if image.mode != "RGB":
            image = image.convert("RGB")
        image.save(buffer, format="JPEG", quality=95)
        return buffer.getvalue(), "jpg", "image/jpeg"

    if output_format == "png":
        image.save(buffer, format="PNG")
        return buffer.getvalue(), "png", "image/png"

    image.save(buffer, format="TIFF")
    return buffer.getvalue(), "tiff", "image/tiff"


@app.post("/scan", response_model=ScanResponse)
async def scan_document(request: ScanRequest) -> ScanResponse:
    _cleanup_stale_files()

    scanners, _, error_output = await _discover_scanners()
    if not scanners:
        message = error_output.strip() or "No scanner discovered by scanimage -L"
        raise HTTPException(status_code=503, detail=message)

    selected_device = SCAN_DEVICE or scanners[0].device_id

    args = [
        "--device-name",
        selected_device,
        "--resolution",
        str(request.resolution),
        "--mode",
        request.color_mode,
        "--format=pnm",
    ]

    code, raw_scan, stderr = await _run_scanimage(args)

    if code != 0 and not raw_scan:
        message = stderr or f"scanimage exited with code {code}"
        raise HTTPException(status_code=500, detail=message)

    if not raw_scan:
        raise HTTPException(status_code=502, detail="scanimage returned no scan data")

    try:
        output_bytes, extension, content_type = _convert_scan_bytes(raw_scan, request.output_format, request.resolution)
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to process scan output: {error}") from error

    filename = f"scan-{uuid.uuid4().hex}.{extension}"
    output_path = SCANNER_OUTPUT_DIR / filename

    try:
        output_path.write_bytes(output_bytes)
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Failed to persist scan: {error}") from error

    return ScanResponse(
        filename=filename,
        output_format=request.output_format,
        content_type=content_type,
        size_bytes=len(output_bytes),
        download_url=f"/scan/download/{filename}",
    )


@app.get("/scan/download/{filename}")
async def download_scan(filename: str) -> FileResponse:
    if not SAFE_FILENAME_RE.fullmatch(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")

    output_path = (SCANNER_OUTPUT_DIR / filename).resolve()
    if output_path.parent != SCANNER_OUTPUT_DIR:
        raise HTTPException(status_code=400, detail="Invalid filename path")

    if not output_path.exists() or not output_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    media_type = mimetypes.guess_type(str(output_path))[0] or "application/octet-stream"

    return FileResponse(
        output_path,
        media_type=media_type,
        filename=filename,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/status", response_model=StatusResponse)
async def scanner_status() -> StatusResponse:
    scanners, code, details = await _discover_scanners()

    if scanners:
        return StatusResponse(ok=True, scanner_reachable=True, scanners=scanners)

    message = details.strip() or "No scanner discovered by scanimage -L"
    return StatusResponse(ok=code == 0, scanner_reachable=False, scanners=[], message=message)
