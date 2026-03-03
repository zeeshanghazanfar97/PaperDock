import { execFile, spawn } from "node:child_process";

export class CommandError extends Error {
  stdout: string;
  stderr: string;
  code: number | string | null;

  constructor(message: string, params: { stdout?: string; stderr?: string; code?: number | string | null } = {}) {
    super(message);
    this.stdout = params.stdout ?? "";
    this.stderr = params.stderr ?? "";
    this.code = params.code ?? null;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    cwd?: string;
    maxBuffer?: number;
  } = {}
) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8", cwd: options.cwd, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        reject(new CommandError(`${command} failed: ${error.message}`, { stdout, stderr, code: error.code ?? null }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function spawnCommand(command: string, args: string[]) {
  return spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
}
