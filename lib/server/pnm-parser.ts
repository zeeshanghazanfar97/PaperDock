export interface PnmHeader {
  magic: "P5" | "P6";
  width: number;
  height: number;
  maxValue: number;
  channels: 1 | 3;
}

function isWs(byte: number) {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0b || byte === 0x0c;
}

function parseHeader(buffer: Buffer): { header: PnmHeader; dataStart: number } | null {
  let index = 0;
  const tokens: string[] = [];

  while (tokens.length < 4) {
    while (index < buffer.length) {
      const ch = buffer[index];
      if (isWs(ch)) {
        index += 1;
        continue;
      }
      if (ch === 0x23) {
        while (index < buffer.length && buffer[index] !== 0x0a) {
          index += 1;
        }
        continue;
      }
      break;
    }

    if (index >= buffer.length) {
      return null;
    }

    const start = index;
    while (index < buffer.length && !isWs(buffer[index]) && buffer[index] !== 0x23) {
      index += 1;
    }

    if (index >= buffer.length) {
      return null;
    }

    tokens.push(buffer.toString("ascii", start, index));
  }

  if (!isWs(buffer[index])) {
    return null;
  }

  const magic = tokens[0];
  if (magic !== "P5" && magic !== "P6") {
    throw new Error(`Unsupported PNM magic format: ${magic}`);
  }

  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const maxValue = Number(tokens[3]);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid PNM dimensions");
  }

  if (!Number.isFinite(maxValue) || maxValue <= 0 || maxValue > 255) {
    throw new Error(`Unsupported max value: ${tokens[3]}`);
  }

  return {
    header: {
      magic,
      width,
      height,
      maxValue,
      channels: magic === "P6" ? 3 : 1
    },
    dataStart: index + 1
  };
}

export class PnmStreamParser {
  private header: PnmHeader | null = null;
  private rawHeaderBuffer = Buffer.alloc(0);
  private remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private rowCursor = 0;

  constructor(
    private readonly callbacks: {
      onHeader: (header: PnmHeader) => void;
      onRows: (rows: Buffer, startRow: number, rowCount: number) => void;
    }
  ) {}

  push(chunk: Buffer) {
    if (!this.header) {
      this.rawHeaderBuffer = Buffer.concat([this.rawHeaderBuffer, chunk]);
      const parsed = parseHeader(this.rawHeaderBuffer);

      if (!parsed) {
        return;
      }

      this.header = parsed.header;
      this.callbacks.onHeader(parsed.header);

      const initialData = this.rawHeaderBuffer.subarray(parsed.dataStart);
      this.rawHeaderBuffer = Buffer.alloc(0);
      this.consumePixelData(initialData);
      return;
    }

    this.consumePixelData(chunk);
  }

  finish() {
    if (!this.header) {
      throw new Error("PNM header was never parsed");
    }

    if (this.rowCursor !== this.header.height) {
      throw new Error(`Scan ended early: expected ${this.header.height} rows, got ${this.rowCursor}`);
    }
  }

  getHeader() {
    return this.header;
  }

  private consumePixelData(chunk: Buffer) {
    if (!this.header) {
      throw new Error("Header unavailable");
    }

    const rowBytes = this.header.width * this.header.channels;
    const combined = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;

    if (!combined.length) {
      return;
    }

    const availableRows = Math.floor(combined.length / rowBytes);
    const maxRows = this.header.height - this.rowCursor;
    const rowsToEmit = Math.min(availableRows, maxRows);

    if (rowsToEmit <= 0) {
      this.remainder = Buffer.from(combined);
      return;
    }

    const bytesToEmit = rowsToEmit * rowBytes;
    const rowPayload = combined.subarray(0, bytesToEmit);

    this.callbacks.onRows(rowPayload, this.rowCursor, rowsToEmit);
    this.rowCursor += rowsToEmit;

    this.remainder = Buffer.from(combined.subarray(bytesToEmit));
  }
}
