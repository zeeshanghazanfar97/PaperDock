export type JobType = "print" | "scan";

export type JobStatus =
  | "queued"
  | "running"
  | "submitted"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorMessage: string | null;
  meta: Record<string, unknown>;
}

export interface ArtifactRecord {
  id: string;
  jobId: string;
  kind: "upload" | "scan_png" | "scan_pdf";
  path: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
  deletedAt: number | null;
}

export interface JobEventRecord {
  id: number;
  jobId: string;
  ts: number;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ScanHeaderEvent {
  width: number;
  height: number;
  channels: number;
  dpi: number;
  mode: "Color" | "Gray";
  previewWidth?: number;
  previewHeight?: number;
  previewRowStride?: number;
  previewColStride?: number;
}

export interface ScanRowsEvent {
  startRow: number;
  rowCount: number;
  channels: number;
  width: number;
  dataBase64: string;
}

export interface ScanProgressEvent {
  percent: number;
}

export interface ScanCompleteEvent {
  pngUrl: string;
  pdfUrl: string;
  partial?: boolean;
  expectedRows?: number;
  actualRows?: number;
}

export interface ScanErrorEvent {
  message: string;
}

export interface SseJobEvent {
  type: "scan_header" | "scan_rows" | "scan_progress" | "scan_complete" | "scan_error";
  payload: ScanHeaderEvent | ScanRowsEvent | ScanProgressEvent | ScanCompleteEvent | ScanErrorEvent;
}
