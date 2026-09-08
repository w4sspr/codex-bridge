import { randomUUID } from "node:crypto";
import { codexHomeFromSystem } from "./config";

export const BRIDGE_PREFIX = "[claude-code bridge] ";

const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const QUEUE_SUCCESS = new RegExp(
  `^Queued message (${UUID_PATTERN}) for thread (${UUID_PATTERN})\\.\\s*$`,
);
const REQUEST_ID = new RegExp(`^${UUID_PATTERN}$`);
const QUEUE_TIMEOUT_MS = 30_000;

export function validateRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new Error("request_id must be a UUID");
  }
  return value.toLowerCase();
}

export function requestMarker(requestId: string): string {
  return `${BRIDGE_PREFIX}[request:${validateRequestId(requestId)}]\n`;
}

export function frameMessage(message: string): string {
  let body = message;
  while (body.startsWith(BRIDGE_PREFIX)) body = body.slice(BRIDGE_PREFIX.length);
  return `${BRIDGE_PREFIX}${body}`;
}

export function parseQueueSuccess(stdout: string): string {
  const match = QUEUE_SUCCESS.exec(stdout);
  if (!match) throw new Error(`Unexpected codex queue output: ${stdout.trim()}`);
  return match[1]!;
}

export function queueFailureMessage(stderr: string): string {
  if (!stderr.includes("no rollout found")) return stderr;
  return (
    "This Codex session has not been persisted yet. Type a first message in that Codex window, then try again.\n\n" +
    stderr
  );
}

export type QueueResult = {
  queuedId: string;
  requestId: string;
  framedMessage: string;
};

export type QueueOptions = {
  timeoutMs?: number;
};

export async function queueMessage(
  thread: string,
  message: string,
  options: QueueOptions = {},
): Promise<QueueResult> {
  const timeoutMs = options.timeoutMs ?? QUEUE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Queue timeout must be a positive number");
  }
  const requestId = randomUUID();
  const framedMessage = requestMarker(requestId) + frameMessage(message).slice(BRIDGE_PREFIX.length);
  const subprocess = Bun.spawn(["codex", "queue", "--thread", thread, "--message", framedMessage], {
    env: { ...process.env, CODEX_HOME: codexHomeFromSystem() },
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
  const uncertainDelivery = (detail: string) => new Error(
    `${detail} Delivery may already have happened; do not automatically resend. ` +
    `Recover with codex_wait_reply using request_id '${requestId}'.`,
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Codex may have spawned an app-server. Stop the whole group, including
      // children that could otherwise keep its output pipes open indefinitely.
      try { process.kill(-subprocess.pid, "SIGKILL"); }
      catch {
        try { subprocess.kill("SIGKILL"); } catch { /* Process may already have exited. */ }
      }
      reject(uncertainDelivery(`Codex queue exceeded ${timeoutMs} ms and was killed.`));
    }, timeoutMs);
  });

  try {
    const [exitCode, stdout, stderr] = await Promise.race([output, deadline]);
    if (exitCode !== 0) {
      throw uncertainDelivery(queueFailureMessage(stderr || stdout || `Codex queue exited ${exitCode}.`));
    }
    let queuedId: string;
    try { queuedId = parseQueueSuccess(stdout); }
    catch (error) { throw uncertainDelivery(error instanceof Error ? error.message : String(error)); }
    return { queuedId, requestId, framedMessage };
  } finally {
    clearTimeout(timer);
  }
}
