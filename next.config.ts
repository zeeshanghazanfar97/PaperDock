import type { NextConfig } from "next";

const DEFAULT_PROXY_BODY_LIMIT_MB = 100;
const configuredUploadMb = Number.parseInt(process.env.MAX_UPLOAD_MB ?? "", 10);
const proxyBodyLimitMb = Number.isFinite(configuredUploadMb) && configuredUploadMb > 0 ? configuredUploadMb : DEFAULT_PROXY_BODY_LIMIT_MB;

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Next.js enforces this limit before route handlers parse multipart/form-data.
    // Keep this at least as large as runtime MAX_UPLOAD_MB checks in the API route.
    proxyClientMaxBodySize: `${proxyBodyLimitMb}mb`
  }
};

export default nextConfig;
