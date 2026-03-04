"use client";

import { type DragEvent as ReactDragEvent, type FormEvent, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";

import { Crop, Download, FileText, ImageIcon, MoonStar, RefreshCw, RotateCcw, RotateCw, ScanLine, SendHorizontal, Sun, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type PrinterInfo = {
  name: string;
  state: string;
  isDefault: boolean;
};

type ScannerInfo = {
  deviceId: string;
  description: string;
};

type Artifact = {
  id: string;
  kind: string;
  mime: string;
  sizeBytes: number;
  createdAt: number;
  deletedAt: number | null;
};

type Job = {
  id: string;
  type: "print" | "scan";
  status: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorMessage: string | null;
  meta: Record<string, unknown>;
  artifacts: Artifact[];
};

type ScanHeader = {
  width: number;
  height: number;
  channels: number;
  dpi: number;
  mode: "Color" | "Gray";
  previewWidth?: number;
  previewHeight?: number;
  previewRowStride?: number;
  previewColStride?: number;
};

type PageMode = "all" | "single" | "range";
type PrintScaling = "auto" | "fit" | "fill" | "none";
type PrintOrientation = "auto" | "portrait" | "landscape";
type PrintSides = "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
type CropRect = { x: number; y: number; width: number; height: number };
type EditorBox = { x: number; y: number; width: number; height: number; scale: number; sourceWidth: number; sourceHeight: number };

function decodeBase64(input: string) {
  const raw = atob(input);
  const array = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    array[i] = raw.charCodeAt(i);
  }
  return array;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: number) {
  return new Date(value).toLocaleString();
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") {
    return "default";
  }
  if (status === "failed" || status === "interrupted") {
    return "destructive";
  }
  if (status === "canceled") {
    return "outline";
  }
  return "secondary";
}

function scanFormatForArtifactKind(kind: string): "png" | "pdf" | "jpeg" | "tiff" | "pnm" | null {
  if (kind === "scan_png") {
    return "png";
  }
  if (kind === "scan_pdf") {
    return "pdf";
  }
  if (kind === "scan_jpeg") {
    return "jpeg";
  }
  if (kind === "scan_tiff") {
    return "tiff";
  }
  if (kind === "scan_pnm") {
    return "pnm";
  }
  return null;
}

function isPdfUpload(file: File | null) {
  if (!file) {
    return false;
  }
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isAllowedPrintFile(file: File) {
  const name = file.name.toLowerCase();
  const acceptedMime = ["application/pdf", "image/png", "image/jpeg"];
  const acceptedExtension = [".pdf", ".png", ".jpg", ".jpeg"];
  return acceptedMime.includes(file.type) || acceptedExtension.some((ext) => name.endsWith(ext));
}

function parsePageRangeInput(value: string, maxPage?: number) {
  const normalized = value.replace(/\s+/g, "");

  if (!normalized) {
    return { valid: false, normalized, firstPage: 1, error: "Page range is empty" };
  }

  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(normalized)) {
    return { valid: false, normalized, firstPage: 1, error: "Use format like 2 or 1-3,5,8-10" };
  }

  let firstPage = 1;
  let firstSet = false;

  for (const segment of normalized.split(",")) {
    const [startRaw, endRaw] = segment.split("-");
    const start = Number(startRaw);
    const end = endRaw ? Number(endRaw) : start;

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return { valid: false, normalized, firstPage: 1, error: "Invalid numeric page range" };
    }

    if (typeof maxPage === "number" && (start > maxPage || end > maxPage)) {
      return { valid: false, normalized, firstPage: 1, error: `Pages must be between 1 and ${maxPage}` };
    }

    if (!firstSet) {
      firstPage = start;
      firstSet = true;
    }
  }

  return { valid: true, normalized, firstPage };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRotation(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  let next = value;
  while (next > 180) {
    next -= 360;
  }
  while (next < -180) {
    next += 360;
  }
  return Number(next.toFixed(1));
}

function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load preview image"));
    image.src = src;
  });
}

function dataUrlToBytes(dataUrl: string) {
  const base64 = dataUrl.split(",")[1] ?? "";
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

export function Dashboard() {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [scanners, setScanners] = useState<ScannerInfo[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState<string>("");
  const [copies, setCopies] = useState<number>(1);
  const [media, setMedia] = useState<string>("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [printDropActive, setPrintDropActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pageMode, setPageMode] = useState<PageMode>("all");
  const [singlePage, setSinglePage] = useState<number>(1);
  const [pageRange, setPageRange] = useState<string>("");
  const [printScaling, setPrintScaling] = useState<PrintScaling>("auto");
  const [printOrientation, setPrintOrientation] = useState<PrintOrientation>("auto");
  const [printSides, setPrintSides] = useState<PrintSides>("one-sided");
  const [scanDpi, setScanDpi] = useState<string>("150");
  const [scanMode, setScanMode] = useState<"Color" | "Gray">("Color");
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [scanHeader, setScanHeader] = useState<ScanHeader | null>(null);
  const [activeScanJobId, setActiveScanJobId] = useState<string | null>(null);
  const [scanDownloadUrls, setScanDownloadUrls] = useState<{ pngUrl: string; pdfUrl: string } | null>(null);
  const [editorImageLoaded, setEditorImageLoaded] = useState(false);
  const [rotationAngle, setRotationAngle] = useState<number>(0);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [draggingCrop, setDraggingCrop] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [historyType, setHistoryType] = useState<string>("all");
  const [historyStatus, setHistoryStatus] = useState<string>("all");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const eventSourceRef = useRef<EventSource | null>(null);
  const printFileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const dirtyRowsRef = useRef<{ start: number; end: number } | null>(null);
  const renderScheduledRef = useRef(false);
  const editorImageRef = useRef<HTMLImageElement | null>(null);
  const rotatedImageRef = useRef<{ image: HTMLImageElement | null; angle: number; canvas: HTMLCanvasElement | null }>({
    image: null,
    angle: 0,
    canvas: null
  });
  const editorBoxRef = useRef<EditorBox | null>(null);
  const cropStartRef = useRef<{ x: number; y: number } | null>(null);

  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (historyType !== "all" && job.type !== historyType) {
        return false;
      }
      if (historyStatus !== "all" && job.status !== historyStatus) {
        return false;
      }
      return true;
    });
  }, [historyStatus, historyType, jobs]);

  const uploadedPdf = isPdfUpload(uploadFile);

  const parsedRangeForPreview = useMemo(() => {
    if (pageMode !== "range") {
      return null;
    }
    return parsePageRangeInput(pageRange, pdfPageCount ?? undefined);
  }, [pageMode, pageRange, pdfPageCount]);

  const previewPdfPage = useMemo(() => {
    if (pageMode === "single") {
      return singlePage;
    }
    if (pageMode === "range" && parsedRangeForPreview?.valid) {
      return parsedRangeForPreview.firstPage;
    }
    return 1;
  }, [pageMode, parsedRangeForPreview, singlePage]);

  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "dark" : "light");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let localPreviewUrl: string | null = null;

    async function setupPreview() {
      if (!uploadFile) {
        setPreviewUrl(null);
        setPdfPageCount(null);
        return;
      }

      localPreviewUrl = URL.createObjectURL(uploadFile);
      setPreviewUrl(localPreviewUrl);

      if (!isPdfUpload(uploadFile)) {
        setPdfPageCount(null);
        return;
      }

      try {
        const { PDFDocument } = await import("pdf-lib");
        const bytes = await uploadFile.arrayBuffer();
        const document = await PDFDocument.load(bytes);

        if (cancelled) {
          return;
        }

        const count = document.getPageCount();
        setPdfPageCount(count);
        setSinglePage((prev) => Math.min(Math.max(1, prev), count));
      } catch {
        if (cancelled) {
          return;
        }
        setPdfPageCount(null);
        setPageMode("all");
        toast.error("Could not read PDF pages. Printing will use all pages unless you set a range manually.");
      }
    }

    void setupPreview();

    return () => {
      cancelled = true;
      if (localPreviewUrl) {
        URL.revokeObjectURL(localPreviewUrl);
      }
    };
  }, [uploadFile]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitial() {
      try {
        setLoading(true);

        const [printersResp, scannersResp, jobsResp] = await Promise.all([
          fetch("/api/printers", { cache: "no-store" }),
          fetch("/api/scanners", { cache: "no-store" }),
          fetch("/api/jobs?limit=30", { cache: "no-store" })
        ]);

        const [printersJson, scannersJson, jobsJson] = await Promise.all([
          printersResp.json(),
          scannersResp.json(),
          jobsResp.json()
        ]);

        if (cancelled) {
          return;
        }

        setPrinters(printersJson.printers ?? []);
        setScanners(scannersJson.scanners ?? []);
        setJobs(jobsJson.items ?? []);

        const nextDefault =
          printersJson.defaultPrinter ??
          printersJson.printers?.find((printer: PrinterInfo) => printer.isDefault)?.name ??
          printersJson.printers?.[0]?.name ??
          "";

        setSelectedPrinter(nextDefault);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load data");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadInitial();

    return () => {
      cancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshJobs();
    }, 6000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!editorImageLoaded || activeScanJobId) {
      return;
    }
    drawEditorCanvas(cropRect, rotationAngle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScanJobId, cropRect, editorImageLoaded, rotationAngle, theme]);

  useEffect(() => {
    const onResize = () => {
      if (!editorImageLoaded || activeScanJobId) {
        return;
      }
      drawEditorCanvas(cropRect, rotationAngle);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScanJobId, cropRect, editorImageLoaded, rotationAngle]);

  useEffect(() => {
    if (!draggingCrop) {
      return;
    }

    const onMouseUp = () => finishCropSelection();
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingCrop]);

  async function refreshJobs() {
    try {
      setRefreshing(true);
      const response = await fetch("/api/jobs?limit=40", { cache: "no-store" });
      const json = await response.json();
      setJobs(json.items ?? []);
    } finally {
      setRefreshing(false);
    }
  }

  function resetCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    imageDataRef.current = null;
    dirtyRowsRef.current = null;
    renderScheduledRef.current = false;
  }

  function flushPreviewRows() {
    const imageData = imageDataRef.current;
    const dirty = dirtyRowsRef.current;
    const canvas = canvasRef.current;
    if (!imageData || !dirty || !canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const start = Math.max(0, dirty.start);
    const end = Math.min(imageData.height, dirty.end);
    if (end <= start) {
      dirtyRowsRef.current = null;
      return;
    }

    const width = imageData.width;
    const from = start * width * 4;
    const to = end * width * 4;
    const chunk = imageData.data.slice(from, to);
    const partial = new ImageData(chunk, width, end - start);
    context.putImageData(partial, 0, start);
    dirtyRowsRef.current = null;
  }

  function schedulePreviewRender() {
    if (renderScheduledRef.current) {
      return;
    }
    renderScheduledRef.current = true;
    requestAnimationFrame(() => {
      renderScheduledRef.current = false;
      flushPreviewRows();
    });
  }

  function clearRotatedCache() {
    rotatedImageRef.current = {
      image: null,
      angle: 0,
      canvas: null
    };
  }

  function getRotatedSourceCanvas(image: HTMLImageElement, angle = rotationAngle) {
    const normalized = normalizeRotation(angle);
    const cached = rotatedImageRef.current;
    if (cached.image === image && cached.canvas && cached.angle === normalized) {
      return cached.canvas;
    }

    const radians = (normalized * Math.PI) / 180;
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));
    const rotatedWidth = Math.max(1, Math.ceil(sourceWidth * absCos + sourceHeight * absSin));
    const rotatedHeight = Math.max(1, Math.ceil(sourceWidth * absSin + sourceHeight * absCos));

    const buffer = document.createElement("canvas");
    buffer.width = rotatedWidth;
    buffer.height = rotatedHeight;
    const context = buffer.getContext("2d");
    if (!context) {
      return null;
    }

    context.translate(rotatedWidth / 2, rotatedHeight / 2);
    context.rotate(radians);
    context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2);

    rotatedImageRef.current = {
      image,
      angle: normalized,
      canvas: buffer
    };
    return buffer;
  }

  async function loadEditorImageFromUrl(pngUrl: string) {
    const cacheBusted = `${pngUrl}${pngUrl.includes("?") ? "&" : "?"}ts=${Date.now()}`;
    try {
      const image = await loadImageElement(cacheBusted);
      editorImageRef.current = image;
      clearRotatedCache();
      setRotationAngle(0);
      setEditorImageLoaded(true);
      setCropRect(null);
      cropStartRef.current = null;
      imageDataRef.current = null;
      dirtyRowsRef.current = null;
      drawEditorCanvas(null, 0);
    } catch (error) {
      editorImageRef.current = null;
      clearRotatedCache();
      setEditorImageLoaded(false);
      setCropRect(null);
      toast.error(error instanceof Error ? error.message : "Failed to load final scan image");
    }
  }

  function drawEditorCanvas(nextCrop: CropRect | null = cropRect, angle = rotationAngle) {
    const canvas = canvasRef.current;
    const image = editorImageRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const parentWidth = canvas.parentElement?.clientWidth ?? 760;
    const width = Math.max(420, Math.min(1200, Math.floor(parentWidth)));
    const height = Math.max(260, Math.floor(width * 0.72));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.fillStyle = "rgba(0,0,0,0.06)";
    context.fillRect(0, 0, width, height);

    if (!image) {
      editorBoxRef.current = null;
      return;
    }

    const source = getRotatedSourceCanvas(image, angle);
    if (!source) {
      editorBoxRef.current = null;
      return;
    }

    const scale = Math.min(width / source.width, height / source.height);
    const drawWidth = Math.max(1, Math.round(source.width * scale));
    const drawHeight = Math.max(1, Math.round(source.height * scale));
    const offsetX = Math.floor((width - drawWidth) / 2);
    const offsetY = Math.floor((height - drawHeight) / 2);

    editorBoxRef.current = {
      x: offsetX,
      y: offsetY,
      width: drawWidth,
      height: drawHeight,
      scale,
      sourceWidth: source.width,
      sourceHeight: source.height
    };

    context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);

    if (!nextCrop || nextCrop.width < 2 || nextCrop.height < 2) {
      return;
    }

    const cropX = offsetX + nextCrop.x * scale;
    const cropY = offsetY + nextCrop.y * scale;
    const cropW = nextCrop.width * scale;
    const cropH = nextCrop.height * scale;

    context.save();
    context.fillStyle = "rgba(0, 0, 0, 0.48)";
    context.fillRect(offsetX, offsetY, drawWidth, drawHeight);
    context.drawImage(source, nextCrop.x, nextCrop.y, nextCrop.width, nextCrop.height, cropX, cropY, cropW, cropH);
    context.strokeStyle = "rgba(34, 197, 94, 0.95)";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.strokeRect(cropX, cropY, cropW, cropH);
    context.setLineDash([]);
    context.restore();
  }

  function toImageCoords(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    const image = editorImageRef.current;
    const box = editorBoxRef.current;
    if (!canvas || !image || !box) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }

    const canvasX = (clientX - rect.left) * (canvas.width / rect.width);
    const canvasY = (clientY - rect.top) * (canvas.height / rect.height);

    if (canvasX < box.x || canvasX > box.x + box.width || canvasY < box.y || canvasY > box.y + box.height) {
      return null;
    }

    const imageX = clamp(Math.round((canvasX - box.x) / box.scale), 0, box.sourceWidth - 1);
    const imageY = clamp(Math.round((canvasY - box.y) / box.scale), 0, box.sourceHeight - 1);

    return { x: imageX, y: imageY };
  }

  function onEditorMouseDown(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (!editorImageLoaded || activeScanJobId) {
      return;
    }

    const point = toImageCoords(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    cropStartRef.current = point;
    setDraggingCrop(true);
    const seedCrop = { x: point.x, y: point.y, width: 1, height: 1 };
    setCropRect(seedCrop);
    drawEditorCanvas(seedCrop, rotationAngle);
  }

  function onEditorMouseMove(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (!draggingCrop || !cropStartRef.current) {
      return;
    }

    const point = toImageCoords(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    const start = cropStartRef.current;
    const x = Math.min(start.x, point.x);
    const y = Math.min(start.y, point.y);
    const width = Math.abs(point.x - start.x) + 1;
    const height = Math.abs(point.y - start.y) + 1;
    const nextCrop = { x, y, width, height };

    setCropRect(nextCrop);
    drawEditorCanvas(nextCrop, rotationAngle);
  }

  function finishCropSelection() {
    if (!draggingCrop) {
      return;
    }

    setDraggingCrop(false);
    cropStartRef.current = null;
    setCropRect((current) => {
      if (!current || current.width < 8 || current.height < 8) {
        drawEditorCanvas(null, rotationAngle);
        return null;
      }
      drawEditorCanvas(current, rotationAngle);
      return current;
    });
  }

  function getEditorExportCanvas() {
    const image = editorImageRef.current;
    if (!image) {
      return null;
    }

    const source = getRotatedSourceCanvas(image, rotationAngle);
    if (!source) {
      return null;
    }

    const target = cropRect ?? { x: 0, y: 0, width: source.width, height: source.height };
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = Math.max(1, Math.round(target.width));
    exportCanvas.height = Math.max(1, Math.round(target.height));
    const context = exportCanvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(
      source,
      target.x,
      target.y,
      target.width,
      target.height,
      0,
      0,
      exportCanvas.width,
      exportCanvas.height
    );
    return exportCanvas;
  }

  async function applyCropToImage() {
    if (!cropRect) {
      toast.error("Select a crop area first");
      return;
    }

    const exportCanvas = getEditorExportCanvas();
    if (!exportCanvas) {
      toast.error("No image available for editing");
      return;
    }

    setEditorBusy(true);
    try {
      const nextImage = await loadImageElement(exportCanvas.toDataURL("image/png"));
      editorImageRef.current = nextImage;
      clearRotatedCache();
      setRotationAngle(0);
      setCropRect(null);
      drawEditorCanvas(null, 0);
      toast.success("Crop applied");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to apply crop");
    } finally {
      setEditorBusy(false);
    }
  }

  function clearCropSelection() {
    setCropRect(null);
    drawEditorCanvas(null, rotationAngle);
  }

  function setEditorRotation(nextValue: number) {
    const normalized = normalizeRotation(nextValue);
    clearRotatedCache();
    setRotationAngle(normalized);
    setCropRect(null);
    drawEditorCanvas(null, normalized);
  }

  function downloadBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadEditedPng() {
    const exportCanvas = getEditorExportCanvas();
    if (!exportCanvas) {
      toast.error("No edited image available");
      return;
    }

    exportCanvas.toBlob((blob) => {
      if (!blob) {
        toast.error("Failed to export PNG");
        return;
      }
      downloadBlob(blob, `scan-edited-${Date.now()}.png`);
    }, "image/png");
  }

  async function downloadEditedPdf() {
    const exportCanvas = getEditorExportCanvas();
    if (!exportCanvas) {
      toast.error("No edited image available");
      return;
    }

    setEditorBusy(true);
    try {
      const { PDFDocument } = await import("pdf-lib");
      const pngBytes = dataUrlToBytes(exportCanvas.toDataURL("image/png"));
      const document = await PDFDocument.create();
      const image = await document.embedPng(pngBytes);
      const dpi = scanHeader?.dpi ?? 150;
      const widthPt = (exportCanvas.width * 72) / dpi;
      const heightPt = (exportCanvas.height * 72) / dpi;
      const page = document.addPage([widthPt, heightPt]);
      page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
      const pdfBytes = await document.save();
      const safePdfBytes = new Uint8Array(pdfBytes);
      downloadBlob(new Blob([safePdfBytes], { type: "application/pdf" }), `scan-edited-${Date.now()}.pdf`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export PDF");
    } finally {
      setEditorBusy(false);
    }
  }

  function closeScanEvents() {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }

  function setSelectedPrintFile(nextFile: File | null) {
    if (nextFile && !isAllowedPrintFile(nextFile)) {
      toast.error("Only PDF, PNG, JPG, and JPEG files are supported.");
      if (printFileInputRef.current) {
        printFileInputRef.current.value = "";
      }
      return;
    }

    setUploadFile(nextFile);
    setPageMode("all");
    setSinglePage(1);
    setPageRange("");
  }

  function onPrintDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setPrintDropActive(false);
    const nextFile = event.dataTransfer.files?.[0] ?? null;
    setSelectedPrintFile(nextFile);
  }

  function clearPrintFileSelection() {
    if (printFileInputRef.current) {
      printFileInputRef.current.value = "";
    }
    setSelectedPrintFile(null);
  }

  function connectScanEvents(jobId: string) {
    closeScanEvents();

    const stream = new EventSource(`/api/scan/jobs/${jobId}/events`);
    eventSourceRef.current = stream;

    stream.addEventListener("scan_header", (evt) => {
      const payload = JSON.parse((evt as MessageEvent).data) as ScanHeader;
      setScanHeader(payload);
      setScanProgress(0);
      setScanDownloadUrls(null);

      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const previewWidth = payload.previewWidth ?? payload.width;
      const previewHeight = payload.previewHeight ?? payload.height;

      canvas.width = previewWidth;
      canvas.height = previewHeight;

      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      imageDataRef.current = context.createImageData(previewWidth, previewHeight);
      dirtyRowsRef.current = null;
      context.putImageData(imageDataRef.current, 0, 0);
    });

    stream.addEventListener("scan_rows", (evt) => {
      const payload = JSON.parse((evt as MessageEvent).data) as {
        startRow: number;
        rowCount: number;
        channels: number;
        width: number;
        dataBase64: string;
      };

      const imageData = imageDataRef.current;
      if (!imageData) {
        return;
      }

      const rawRows = decodeBase64(payload.dataBase64);
      const width = payload.width;

      for (let rowOffset = 0; rowOffset < payload.rowCount; rowOffset += 1) {
        const globalRow = payload.startRow + rowOffset;

        for (let x = 0; x < width; x += 1) {
          const srcIndex = rowOffset * width * payload.channels + x * payload.channels;
          const dstIndex = (globalRow * width + x) * 4;

          if (payload.channels === 1) {
            const gray = rawRows[srcIndex];
            imageData.data[dstIndex] = gray;
            imageData.data[dstIndex + 1] = gray;
            imageData.data[dstIndex + 2] = gray;
            imageData.data[dstIndex + 3] = 255;
          } else {
            imageData.data[dstIndex] = rawRows[srcIndex];
            imageData.data[dstIndex + 1] = rawRows[srcIndex + 1];
            imageData.data[dstIndex + 2] = rawRows[srcIndex + 2];
            imageData.data[dstIndex + 3] = 255;
          }
        }
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const currentDirty = dirtyRowsRef.current;
      const start = payload.startRow;
      const end = payload.startRow + payload.rowCount;

      if (!currentDirty) {
        dirtyRowsRef.current = { start, end };
      } else {
        dirtyRowsRef.current = {
          start: Math.min(currentDirty.start, start),
          end: Math.max(currentDirty.end, end)
        };
      }
      schedulePreviewRender();
    });

    stream.addEventListener("scan_progress", (evt) => {
      const payload = JSON.parse((evt as MessageEvent).data) as { percent: number };
      setScanProgress(payload.percent);
    });

    stream.addEventListener("scan_complete", (evt) => {
      const payload = JSON.parse((evt as MessageEvent).data) as {
        pngUrl: string;
        pdfUrl: string;
        partial?: boolean;
        expectedRows?: number;
        actualRows?: number;
      };
      flushPreviewRows();
      setScanProgress(100);
      setScanDownloadUrls(payload);
      void loadEditorImageFromUrl(payload.pngUrl);
      setActiveScanJobId(null);
      void refreshJobs();
      if (payload.partial) {
        toast.warning(
          `Scan completed with partial output (${payload.actualRows ?? "?"}/${payload.expectedRows ?? "?"} rows captured).`
        );
      } else {
        toast.success("Scan completed");
      }
      closeScanEvents();
    });

    stream.addEventListener("scan_error", (evt) => {
      const payload = JSON.parse((evt as MessageEvent).data) as { message: string };
      setActiveScanJobId(null);
      toast.error(payload.message);
      void refreshJobs();
      closeScanEvents();
    });

    stream.onerror = () => {
      stream.close();
      eventSourceRef.current = null;
    };
  }

  async function onPrintSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!uploadFile) {
      toast.error("Choose a file to print");
      return;
    }

    if (!selectedPrinter) {
      toast.error("Select a printer");
      return;
    }

    let effectivePageRanges: string | null = null;
    const pdfSelected = isPdfUpload(uploadFile);

    if (pageMode !== "all") {
      if (!pdfSelected) {
        toast.error("Page selection is only available for PDF files");
        return;
      }

      if (pageMode === "single") {
        if (pdfPageCount && (singlePage < 1 || singlePage > pdfPageCount)) {
          toast.error(`Page must be between 1 and ${pdfPageCount}`);
          return;
        }
        effectivePageRanges = String(singlePage);
      } else {
        const parsed = parsePageRangeInput(pageRange, pdfPageCount ?? undefined);
        if (!parsed.valid) {
          toast.error(parsed.error);
          return;
        }
        effectivePageRanges = parsed.normalized;
      }
    }

    const body = new FormData();
    body.set("file", uploadFile);
    body.set("printer", selectedPrinter);
    body.set("copies", String(copies));

    if (media.trim()) {
      body.set("media", media.trim());
    }

    if (effectivePageRanges) {
      body.set("pageRanges", effectivePageRanges);
    }

    body.set("printScaling", printScaling);
    body.set("orientation", printOrientation);
    body.set("sides", printSides);

    const response = await fetch("/api/print/jobs", {
      method: "POST",
      body
    });

    const json = await response.json();

    if (!response.ok) {
      toast.error(json.error ?? "Print request failed");
      return;
    }

    toast.success(`Print job ${json.job?.id ?? "created"}`);
    clearPrintFileSelection();

    setPreviewUrl(null);
    setPdfPageCount(null);

    void refreshJobs();
  }

  async function onStartScan() {
    resetCanvas();
    setScanDownloadUrls(null);
    setScanHeader(null);
    setCropRect(null);
    setRotationAngle(0);
    editorImageRef.current = null;
    clearRotatedCache();
    setEditorImageLoaded(false);
    drawEditorCanvas(null, 0);

    const response = await fetch("/api/scan/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        dpi: Number(scanDpi),
        mode: scanMode
      })
    });

    const json = await response.json();

    if (!response.ok) {
      toast.error(json.error ?? "Failed to start scan");
      return;
    }

    const jobId = json.job?.id as string;
    setActiveScanJobId(jobId);
    setScanProgress(0);
    connectScanEvents(jobId);
    void refreshJobs();
    toast.success("Scan started");
  }

  async function onCancelScan() {
    if (!activeScanJobId) {
      return;
    }

    const response = await fetch(`/api/scan/jobs/${activeScanJobId}/cancel`, {
      method: "POST"
    });

    const json = await response.json();

    if (!response.ok) {
      toast.error(json.error ?? "Cancel failed");
      return;
    }

    setActiveScanJobId(null);
    closeScanEvents();
    toast.success("Scan canceled");
    void refreshJobs();
  }

  async function onPhotoCopy() {
    setCopying(true);

    try {
      const response = await fetch("/api/copy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          dpi: Number(scanDpi),
          mode: scanMode,
          printer: selectedPrinter || undefined,
          copies
        })
      });

      const json = await response.json();

      if (!response.ok) {
        toast.error(json.error ?? "Photocopy failed");
        return;
      }

      toast.success(`Photocopy job ${json.job?.id?.slice?.(0, 8) ?? "submitted"}`);
      void refreshJobs();
    } finally {
      setCopying(false);
    }
  }

  async function onCancelPrint(jobId: string) {
    const response = await fetch(`/api/print/jobs/${jobId}/cancel`, {
      method: "POST"
    });

    const json = await response.json();

    if (!response.ok) {
      toast.error(json.error ?? "Print cancel failed");
      return;
    }

    toast.success("Print job canceled");
    void refreshJobs();
  }

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    const isDark = nextTheme === "dark";

    setTheme(nextTheme);
    document.documentElement.classList.toggle("dark", isDark);
    window.localStorage.setItem("theme", nextTheme);
  }

  return (
    <main className="container py-8 md:py-12">
      <section className="panel-enter mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight md:text-4xl">PaperDock</h1>
          <p className="max-w-3xl text-sm text-muted-foreground md:text-base">
            A self-hosted print and scan desk for your network devices. Send documents, monitor live scan progress, and export polished
            files from one place.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={toggleTheme} className="sm:mt-1">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <MoonStar className="h-4 w-4" />}
          {theme === "dark" ? "Light Mode" : "Dark Mode"}
        </Button>
      </section>

      <Tabs defaultValue="print" className="panel-enter-delayed">
        <TabsList className="grid w-full max-w-xl grid-cols-2">
          <TabsTrigger value="print" className="gap-2">
            <SendHorizontal className="h-4 w-4" />
            Print
          </TabsTrigger>
          <TabsTrigger value="scan" className="gap-2">
            <ScanLine className="h-4 w-4" />
            Scan
          </TabsTrigger>
        </TabsList>

        <TabsContent value="print">
          <Card>
            <CardHeader>
              <CardTitle>Upload & Print</CardTitle>
              <CardDescription>
                Supports PDF, PNG, JPG, JPEG. Preview your upload, pick PDF pages, and tune print options before submitting.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onPrintSubmit} className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                <div className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="print-file">Document</Label>
                    <input
                      ref={printFileInputRef}
                      id="print-file"
                      type="file"
                      accept="application/pdf,image/png,image/jpeg"
                      className="sr-only"
                      onChange={(event) => {
                        const nextFile = event.target.files?.[0] ?? null;
                        setSelectedPrintFile(nextFile);
                      }}
                    />
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => printFileInputRef.current?.click()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          printFileInputRef.current?.click();
                        }
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setPrintDropActive(true);
                      }}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setPrintDropActive(true);
                      }}
                      onDragLeave={(event) => {
                        event.preventDefault();
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setPrintDropActive(false);
                        }
                      }}
                      onDrop={onPrintDrop}
                      className={cn(
                        "relative flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-5 py-6 text-center transition-colors",
                        printDropActive
                          ? "border-primary bg-primary/10"
                          : "border-border bg-card/50 hover:border-primary/60 hover:bg-accent/30"
                      )}
                    >
                      <UploadCloud className="h-8 w-8 text-primary" />
                      <div className="space-y-1">
                        <p className="text-sm font-semibold">Drop files here or click to browse</p>
                        <p className="text-xs text-muted-foreground">PDF, PNG, JPG, JPEG</p>
                      </div>
                    </div>
                    {uploadFile ? (
                      <div className="flex items-center justify-between gap-2 rounded-lg border bg-card/70 px-3 py-2">
                        <div className="min-w-0 space-y-0.5">
                          <p className="flex items-center gap-2 truncate text-sm font-medium">
                            {uploadedPdf ? <FileText className="h-4 w-4 shrink-0 text-primary" /> : <ImageIcon className="h-4 w-4 shrink-0 text-primary" />}
                            <span className="truncate">{uploadFile.name}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">{formatBytes(uploadFile.size)}</p>
                        </div>
                        <Button type="button" variant="ghost" size="icon" onClick={clearPrintFileSelection} aria-label="Remove file">
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Printer</Label>
                      <Select value={selectedPrinter} onValueChange={setSelectedPrinter}>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose printer" />
                        </SelectTrigger>
                        <SelectContent>
                          {printers.map((printer) => (
                            <SelectItem key={printer.name} value={printer.name}>
                              {printer.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="copies">Copies</Label>
                      <Input
                        id="copies"
                        type="number"
                        min={1}
                        max={99}
                        value={copies}
                        onChange={(event) => setCopies(Math.max(1, Number(event.target.value || "1")))}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="media">Media (optional)</Label>
                    <Input id="media" placeholder="e.g. A4, Letter" value={media} onChange={(event) => setMedia(event.target.value)} />
                  </div>

                  {uploadedPdf ? (
                    <div className="space-y-3 rounded-lg border bg-card/70 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label>PDF Pages</Label>
                        <p className="text-xs text-muted-foreground">{pdfPageCount ? `${pdfPageCount} page(s)` : "Loading page count..."}</p>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Selection</Label>
                          <Select value={pageMode} onValueChange={(value) => setPageMode(value as PageMode)}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">All Pages</SelectItem>
                              <SelectItem value="single">Single Page</SelectItem>
                              <SelectItem value="range">Page Range</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {pageMode === "single" ? (
                          <div className="space-y-2">
                            <Label htmlFor="single-page">Page Number</Label>
                            <Input
                              id="single-page"
                              type="number"
                              min={1}
                              max={pdfPageCount ?? undefined}
                              value={singlePage}
                              onChange={(event) => setSinglePage(Math.max(1, Number(event.target.value || "1")))}
                            />
                          </div>
                        ) : null}

                        {pageMode === "range" ? (
                          <div className="space-y-2 sm:col-span-2">
                            <Label htmlFor="page-range">Page Range</Label>
                            <Input
                              id="page-range"
                              placeholder="e.g. 1-3,5,8-10"
                              value={pageRange}
                              onChange={(event) => setPageRange(event.target.value)}
                            />
                            {pageRange.trim() ? (
                              <p className={`text-xs ${parsedRangeForPreview?.valid ? "text-muted-foreground" : "text-destructive"}`}>
                                {parsedRangeForPreview?.valid ? "Range looks valid." : parsedRangeForPreview?.error}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">Use comma-separated pages and ranges.</p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-3 rounded-lg border bg-card/70 p-4">
                    <Label>Print Options</Label>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label>Scaling</Label>
                        <Select value={printScaling} onValueChange={(value) => setPrintScaling(value as PrintScaling)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            <SelectItem value="fit">Fit Page</SelectItem>
                            <SelectItem value="fill">Fill Page</SelectItem>
                            <SelectItem value="none">No Scaling</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Orientation</Label>
                        <Select value={printOrientation} onValueChange={(value) => setPrintOrientation(value as PrintOrientation)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            <SelectItem value="portrait">Portrait</SelectItem>
                            <SelectItem value="landscape">Landscape</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Sides</Label>
                        <Select value={printSides} onValueChange={(value) => setPrintSides(value as PrintSides)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="one-sided">One-sided</SelectItem>
                            <SelectItem value="two-sided-long-edge">Duplex (Long Edge)</SelectItem>
                            <SelectItem value="two-sided-short-edge">Duplex (Short Edge)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Preview</Label>
                  <div className="h-[480px] overflow-hidden rounded-lg border bg-muted/30">
                    {!previewUrl ? (
                      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                        Upload a PDF or image to preview it here.
                      </div>
                    ) : uploadedPdf ? (
                      <iframe
                        title="PDF preview"
                        src={`${previewUrl}#page=${Math.max(1, previewPdfPage)}&view=FitH`}
                        className="h-full w-full"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previewUrl} alt="Uploaded preview" className="h-full w-full object-contain" />
                    )}
                  </div>
                </div>

                <div className="xl:col-span-2">
                  <Button type="submit" className="w-full md:w-auto">
                    Submit Print Job
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="scan">
          <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
            <Card>
              <CardHeader>
                <CardTitle>Scan Controls</CardTitle>
                <CardDescription>Configure scan options and start/cancel jobs.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Scanner</Label>
                  <div className="rounded-md border bg-card/80 px-3 py-2 text-sm text-muted-foreground">
                    {scanners[0]?.description ?? "No scanner detected"}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>DPI</Label>
                  <Select value={scanDpi} onValueChange={setScanDpi}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="75">75</SelectItem>
                      <SelectItem value="150">150</SelectItem>
                      <SelectItem value="300">300</SelectItem>
                      <SelectItem value="600">600</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Mode</Label>
                  <Select value={scanMode} onValueChange={(value) => setScanMode(value as "Color" | "Gray")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Color">Color</SelectItem>
                      <SelectItem value="Gray">Gray</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2 pt-2">
                  <Button onClick={onStartScan} disabled={Boolean(activeScanJobId)}>
                    Start Scan
                  </Button>
                  <Button variant="outline" onClick={onCancelScan} disabled={!activeScanJobId}>
                    Cancel Scan
                  </Button>
                  <Button variant="secondary" onClick={onPhotoCopy} disabled={Boolean(activeScanJobId) || copying}>
                    {copying ? "Photocopying..." : "Photocopy"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{editorImageLoaded && !activeScanJobId ? "Scan Canvas Editor" : "Live Preview"}</CardTitle>
                <CardDescription>
                  {editorImageLoaded && !activeScanJobId
                    ? "The same canvas now switches to editing mode. Drag on image to select crop."
                    : "Low-cost progressive preview while scanning is running."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      {activeScanJobId ? `Scanning ${activeScanJobId.slice(0, 8)}...` : "Idle"}
                      {scanHeader ? ` (${scanHeader.width}x${scanHeader.height}, ${scanHeader.mode})` : ""}
                      {scanHeader?.previewWidth && scanHeader?.previewHeight
                        ? ` Preview ${scanHeader.previewWidth}x${scanHeader.previewHeight}`
                        : ""}
                    </span>
                    <span>{scanProgress}%</span>
                  </div>
                  <Progress value={scanProgress} />
                </div>

                <div className="rounded-xl border bg-card/60 p-2">
                  <div className="max-h-[560px] overflow-auto rounded-md bg-muted/40">
                    <canvas
                      ref={canvasRef}
                      onMouseDown={onEditorMouseDown}
                      onMouseMove={onEditorMouseMove}
                      onMouseUp={finishCropSelection}
                      onMouseLeave={finishCropSelection}
                      className={`h-auto w-full ${editorImageLoaded && !activeScanJobId ? "cursor-crosshair" : "cursor-default"}`}
                    />
                  </div>
                </div>

                <div className="text-xs text-muted-foreground">
                  {editorImageLoaded && !activeScanJobId
                    ? "Editor mode: drag directly on this canvas to mark crop area."
                    : "Preview mode: rows are rendered progressively to reduce CPU load."}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit & Download</CardTitle>
                <CardDescription>Rotate, crop, and export the final scan image or PDF.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="scan-rotation">Rotation</Label>
                    <span className="text-xs text-muted-foreground">{rotationAngle.toFixed(1)}deg</span>
                  </div>
                  <Input
                    id="scan-rotation"
                    type="range"
                    min={-180}
                    max={180}
                    step={0.1}
                    value={rotationAngle}
                    onChange={(event) => setEditorRotation(Number(event.target.value))}
                    disabled={!editorImageLoaded || Boolean(activeScanJobId) || editorBusy}
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-3">
                  <Button
                    variant="outline"
                    onClick={() => setEditorRotation(rotationAngle - 90)}
                    disabled={!editorImageLoaded || Boolean(activeScanJobId) || editorBusy}
                  >
                    <RotateCcw className="h-4 w-4" />
                    -90deg
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setEditorRotation(0)}
                    disabled={!editorImageLoaded || Boolean(activeScanJobId) || editorBusy}
                  >
                    Reset
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setEditorRotation(rotationAngle + 90)}
                    disabled={!editorImageLoaded || Boolean(activeScanJobId) || editorBusy}
                  >
                    <RotateCw className="h-4 w-4" />
                    +90deg
                  </Button>
                </div>

                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>Rotate to any angle, then drag on the center canvas to choose crop area.</p>
                  {cropRect ? <p>Crop: {Math.round(cropRect.width)} x {Math.round(cropRect.height)} px</p> : <p>No crop selected.</p>}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Button variant="outline" onClick={clearCropSelection} disabled={!cropRect || !editorImageLoaded || editorBusy}>
                    Clear Crop
                  </Button>
                  <Button onClick={() => void applyCropToImage()} disabled={!cropRect || !editorImageLoaded || editorBusy}>
                    <Crop className="h-4 w-4" />
                    Apply Crop
                  </Button>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Button variant="secondary" onClick={() => void downloadEditedPng()} disabled={!editorImageLoaded || editorBusy}>
                    <Download className="h-4 w-4" />
                    Download Edited PNG
                  </Button>
                  <Button variant="secondary" onClick={() => void downloadEditedPdf()} disabled={!editorImageLoaded || editorBusy}>
                    <Download className="h-4 w-4" />
                    Download Edited PDF
                  </Button>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    variant="outline"
                    disabled={!scanDownloadUrls}
                    onClick={() => {
                      if (scanDownloadUrls) {
                        window.open(scanDownloadUrls.pngUrl, "_blank");
                      }
                    }}
                  >
                    Download Original PNG
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!scanDownloadUrls}
                    onClick={() => {
                      if (scanDownloadUrls) {
                        window.open(scanDownloadUrls.pdfUrl, "_blank");
                      }
                    }}
                  >
                    Download Original PDF
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <section className="panel-enter mt-8">
        <Card>
          <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>Job History</CardTitle>
              <CardDescription>SQLite-backed history with append-only JSONL audit tracking.</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={historyType} onValueChange={setHistoryType}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="print">Print</SelectItem>
                  <SelectItem value="scan">Scan</SelectItem>
                </SelectContent>
              </Select>

              <Select value={historyStatus} onValueChange={setHistoryStatus}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="canceled">Canceled</SelectItem>
                  <SelectItem value="interrupted">Interrupted</SelectItem>
                </SelectContent>
              </Select>

              <Button variant="outline" size="sm" onClick={() => void refreshJobs()}>
                <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Artifacts</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      Loading jobs...
                    </TableCell>
                  </TableRow>
                ) : null}

                {!loading && !filteredJobs.length ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No jobs found.
                    </TableCell>
                  </TableRow>
                ) : null}

                {filteredJobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium">{job.id.slice(0, 8)}</TableCell>
                    <TableCell className="capitalize">{job.type}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                      {job.errorMessage ? <p className="mt-1 text-xs text-destructive">{job.errorMessage}</p> : null}
                    </TableCell>
                    <TableCell>{formatDate(job.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {job.artifacts.map((artifact) => {
                          if (artifact.deletedAt) {
                            return (
                              <Badge key={artifact.id} variant="outline">
                                {artifact.kind} expired
                              </Badge>
                            );
                          }

                          const scanFormat = job.type === "scan" ? scanFormatForArtifactKind(artifact.kind) : null;

                          if (scanFormat) {
                            return (
                              <a
                                key={artifact.id}
                                className="inline-flex items-center rounded-md border bg-card/80 px-2 py-1 text-xs font-semibold hover:bg-accent"
                                href={`/api/scan/jobs/${job.id}/download?format=${scanFormat}`}
                              >
                                {artifact.kind} ({formatBytes(artifact.sizeBytes)})
                              </a>
                            );
                          }

                          return (
                            <Badge key={artifact.id} variant="outline">
                              {artifact.kind} ({formatBytes(artifact.sizeBytes)})
                            </Badge>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {job.type === "print" && ["queued", "running", "submitted"].includes(job.status) ? (
                        <Button size="sm" variant="outline" onClick={() => void onCancelPrint(job.id)}>
                          Cancel
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
