import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIDGE_PREFIX,
  frameMessage,
  parseQueueSuccess,
  queueFailureMessage,
} from "./queue";

const queueDirectories: string[] = [];
afterAll(() => { for (const directory of queueDirectories) Bun.spawnSync(["trash", directory]); });

function fakeCodex(source: string) {
  const directory = mkdtempSync("/private/tmp/codex-bridge-queue-");
  queueDirectories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!${process.execPath}\n${source}`);
  chmodSync(executable, 0o755);
  return { directory, bin };
}

async function runQueue(directory: string, requests: Array<{ message: string; timeoutMs?: number }>) {
  const runner = join(directory, "runner.ts");
  writeFileSync(runner, `
    import { queueMessage } from ${JSON.stringify(join(import.meta.dir, "queue.ts"))};
    import { writeFileSync } from 'node:fs';
    const nativeSpawn = Bun.spawn;
    Bun.spawn = (command, options) => {
      const child = nativeSpawn(command, options);
      writeFileSync(${JSON.stringify(join(directory, "started.json"))}, JSON.stringify({pid:child.pid,message:command.at(-1)}));
      return child;
    };
    const output = [];
    for (const request of JSON.parse(process.argv[2])) {
      try { output.push(await queueMessage('11111111-1111-4111-8111-111111111111', request.message, {timeoutMs:request.timeoutMs})); }
      catch(error) { output.push({error:String(error)}); }
    }
    console.log(JSON.stringify(output));
  `);
  // Bun.spawn inherits its process-start environment unless env is explicit.
  // Isolate the runner's initial PATH so old implementations cannot reach a real Codex binary.
  const subprocess = Bun.spawn([process.execPath, runner, JSON.stringify(requests)], {
    env: { ...process.env, PATH: join(directory, "bin") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited, new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Isolated queue runner failed: ${stderr}`);
  return JSON.parse(stdout) as Array<{ requestId: string; framedMessage: string; error?: string }>;
}

describe("queue protocol", () => {
  test("frames empty and unicode messages with exactly one bridge prefix", () => {
    expect(frameMessage("")).toBe("[claude-code bridge] ");
    expect(frameMessage("你好 👋")).toBe("[claude-code bridge] 你好 👋");
    expect(frameMessage(`${BRIDGE_PREFIX}already framed`)).toBe(
      "[claude-code bridge] already framed",
    );
  });

  test("extracts the queued message UUID from exact codex stdout", () => {
    expect(
      parseQueueSuccess(
        "Queued message 123e4567-e89b-12d3-a456-426614174000 for thread 33333333-1111-4111-8111-111111111111.\n",
      ),
    ).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  test("rejects success output without a valid message UUID", () => {
    expect(() => parseQueueSuccess("Queued message maybe for thread also-maybe.\n")).toThrow(
      "Unexpected codex queue output: Queued message maybe for thread also-maybe.",
    );
  });

  test("maps no-rollout stderr to actionable guidance and preserves the original error", () => {
    const stderr =
      "Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id abc (code -32603)";

    expect(queueFailureMessage(stderr)).toBe(
      "This Codex session has not been persisted yet. Type a first message in that Codex window, then try again.\n\nError: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id abc (code -32603)",
    );
    expect(queueFailureMessage("different failure\n")).toBe("different failure\n");
  });

  test("identical messages receive unique recoverable markers and preserve body text", async () => {
    const { directory } = fakeCodex(`console.log('Queued message 123e4567-e89b-12d3-a456-426614174000 for thread 11111111-1111-4111-8111-111111111111.');`);
    const [first, second] = await runQueue(directory, [{ message: "same 👋\nbody" }, { message: "same 👋\nbody" }]);
    expect(first!.error).toBeUndefined();
    expect(second!.error).toBeUndefined();
    expect(first!.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second!.requestId).not.toBe(first!.requestId);
    expect(first!.framedMessage.replace(first!.requestId, "REQUEST_ID")).toBe("[claude-code bridge] [request:REQUEST_ID]\nsame 👋\nbody");
    expect(second!.framedMessage.replace(second!.requestId, "REQUEST_ID")).toBe("[claude-code bridge] [request:REQUEST_ID]\nsame 👋\nbody");
  });

  test("a stalled queue process is killed and the error preserves recovery identity", async () => {
    const { directory } = fakeCodex(`
      setTimeout(() => process.exit(17), 2000);
    `);
    const startedPath = join(directory, "started.json");
    try {
      const startedAt = performance.now();
      const [result] = await runQueue(directory, [{ message: "hello", timeoutMs: 200 }]);
      expect(performance.now() - startedAt).toBeLessThan(1500);
      const failure = result!.error ?? "";
      expect(failure).toContain("Delivery may already have happened");
      expect(failure).toContain("do not automatically resend");
      expect(existsSync(startedPath)).toBe(true);
      const started = JSON.parse(readFileSync(startedPath, "utf8")) as { pid: number; message: string };
      const requestId = /^\[claude-code bridge\] \[request:([^\]]+)\]\nhello$/.exec(started.message)?.[1];
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(failure).toContain(`request_id '${requestId}'`);
      expect(() => process.kill(started.pid, 0)).toThrow();
    } finally {
      if (existsSync(startedPath)) {
        const { pid } = JSON.parse(readFileSync(startedPath, "utf8"));
        try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
  });
});
