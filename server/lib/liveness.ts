import { readdir } from "node:fs/promises";
import { join } from "node:path";

const THREAD_LOCK_NAME =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.lock$/;

export function parseLsofOutput(text: string): Map<string, number> {
  const liveThreads = new Map<string, number>();
  let currentPid: number | null = null;
  let command: string | null = null;
  let file: { access?: string; path?: string; valid: boolean } | null = null;

  function finishFile(): void {
    if (
      currentPid !== null && command === "codex" && file?.valid &&
      (file.access === "u" || file.access === "w") && file.path !== undefined
    ) {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      const match = THREAD_LOCK_NAME.exec(name);
      if (match) liveThreads.set(match[1]!.toLowerCase(), currentPid);
    }
    file = null;
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      finishFile();
      const pidText = line.slice(1);
      const parsed = /^(?:0|[1-9]\d*)$/.test(pidText) ? Number(pidText) : Number.NaN;
      currentPid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      command = null;
      continue;
    }
    if (line.startsWith("c")) {
      command = line.slice(1);
      continue;
    }
    if (line.startsWith("f")) {
      finishFile();
      file = /^f\d+$/.test(line) ? { valid: true } : null;
      continue;
    }
    if (file && line.startsWith("a")) {
      if (file.access !== undefined) file.valid = false;
      file.access = line.slice(1);
      continue;
    }
    if (file && line.startsWith("n")) {
      if (file.path !== undefined) file.valid = false;
      file.path = line.slice(1);
      continue;
    }
    if (line === "") finishFile();
  }
  finishFile();
  return liveThreads;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

export async function probeLiveThreads(
  lockDir: string,
  options: { timeoutMs?: number } = {},
): Promise<Map<string, number>> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("lsof timeout must be a positive finite number");
  }
  let entries;
  try {
    entries = await readdir(lockDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return new Map();
    throw error;
  }

  const lockPaths = entries
    .filter((entry) => entry.isFile() && THREAD_LOCK_NAME.test(entry.name))
    .map((entry) => join(lockDir, entry.name))
    .sort();
  if (lockPaths.length === 0) return new Map();

  try {
    // macOS does not expose flock ownership through lsof. A Codex process with
    // a writable lock descriptor is a liveness heuristic, not proof of ownership.
    const subprocess = Bun.spawn(["lsof", "-F", "pcfan", ...lockPaths], {
      env: process.env,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutError: Error | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // A wrapper may exit while a descendant still holds stdout or stderr.
        // Stop the entire group and reject independently of those output pipes.
        timeoutError = new Error(`lsof timed out after ${timeoutMs} ms`);
        try { process.kill(-subprocess.pid, "SIGKILL"); }
        catch { try { subprocess.kill("SIGKILL"); } catch { /* Already exited. */ } }
        // Give normal exit/pipe cleanup a brief chance to finish, but a child
        // retaining an output pipe can never extend the deadline indefinitely.
        cleanupTimer = setTimeout(() => reject(timeoutError), 100);
      }, timeoutMs);
    });
    try {
      const [exitCode, stdout, stderr] = await Promise.race([output, deadline]);
      if (timeoutError) throw timeoutError;
      const parsed = parseLsofOutput(stdout);
      if (parsed.size > 0 || exitCode === 0 || exitCode === 1) return parsed;

      throw new Error(`lsof failed while probing Codex sessions: ${stderr.trim() || `exit ${exitCode}`}`);
    } finally {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
    }
  } catch (error) {
    if (isMissingPath(error)) return new Map();
    throw error;
  }
}
