import crypto from "node:crypto";
import fs from "node:fs";

export function sha256File(filePath: string) {
  const hash = crypto.createHash("sha256");
  const file = fs.readFileSync(filePath);
  hash.update(file);
  return hash.digest("hex");
}
