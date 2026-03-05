const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecodeToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

export function base64UrlEncodeString(value: string): string {
  return base64UrlEncodeBytes(encoder.encode(value));
}

export function base64UrlDecodeToString(value: string): string {
  return decoder.decode(base64UrlDecodeToBytes(value));
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error("Session secret is empty");
  }

  const cached = hmacKeyCache.get(secret);
  if (cached) {
    return cached;
  }

  const created = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  hmacKeyCache.set(secret, created);
  return created;
}

async function signData(value: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

export async function createSignedToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signature = await signData(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function parseSignedToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature || token.split(".").length !== 2) {
    return null;
  }

  const key = await getHmacKey(secret);
  const verified = await crypto.subtle.verify("HMAC", key, asArrayBuffer(base64UrlDecodeToBytes(signature)), encoder.encode(encodedPayload));
  if (!verified) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecodeToString(encodedPayload)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
