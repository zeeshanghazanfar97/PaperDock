export function logInfo(message: string, details?: Record<string, unknown>) {
  console.info(JSON.stringify({ level: "info", ts: new Date().toISOString(), message, ...details }));
}

export function logError(message: string, details?: Record<string, unknown>) {
  console.error(JSON.stringify({ level: "error", ts: new Date().toISOString(), message, ...details }));
}
