import path from "node:path";

const allowedMime = new Set(["application/pdf", "image/png", "image/jpeg"]);
const allowedExt = new Set([".pdf", ".png", ".jpg", ".jpeg"]);

export function isAllowedUpload(fileName: string, mimeType: string) {
  const ext = path.extname(fileName).toLowerCase();
  return allowedMime.has(mimeType) || allowedExt.has(ext);
}
