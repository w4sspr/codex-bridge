import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callBridgeTool } from "../index";
import { tailRollout } from "./rollout";

const temporaryDirectory = mkdtempSync("/private/tmp/codex-bridge-recovery-");
afterAll(() => { Bun.spawnSync(["trash", temporaryDirectory]); });
const THREAD = "11111111-1111-4111-8111-111111111111";
const FIRST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_COMPLETE = '{"type":"event_msg","payload":{"type":"task_complete"}}\n';

function message(role: "user" | "assistant", text: string): string {
  return JSON.stringify({ type: "response_item", payload: {
    type: "message", role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  } }) + "\n";
}

function setup(name: string, text: string, live = true) {
  const path = join(temporaryDirectory, `${name}.jsonl`);
  writeFileSync(path, text);
  const dependencies = {
    listSessions: () => [{
      id: THREAD, name: "scratch", title: "scratch", cwd: temporaryDirectory,
      updated_at: "2026-01-01T00:00:00.000Z", rollout_path: path,
      rollout_exists: true, live, pid: live ? 123 : null,
    }],
    probeLiveThreads: async () => new Map<string, number>(),
    tailRollout: (path: string, options: Parameters<typeof tailRollout>[1]) =>
      tailRollout(path, { ...options, pollIntervalMs: 5 }),
  };
  return { path, dependencies };
}

describe("request identity and recovery", () => {
  test("returns distinct request IDs and only the matching replies for identical concurrent sends", async () => {
    const { path, dependencies } = setup("concurrent", "");
    let release!: () => void;
    const bothQueued = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const deps = {
      ...dependencies,
      queueMessage: async (_thread: string, text: string) => {
        const requestId = sent.length === 0 ? FIRST : SECOND;
        const framedMessage = `[claude-code bridge] [request:${requestId}]\n${text}`;
        sent.push(framedMessage);
        if (sent.length === 2) {
          appendFileSync(path, message("user", sent[0]!) + message("assistant", "first reply") +
            EVENT_COMPLETE + message("user", sent[1]!) + message("assistant", "second reply") + EVENT_COMPLETE);
          release();
        }
        await bothQueued;
        return { requestId, queuedId: requestId, framedMessage };
      },
    };
    const result = await Promise.all([
      callBridgeTool("codex_send", { thread: THREAD, message: "hello", timeout_s: 0 }, deps),
      callBridgeTool("codex_send", { thread: THREAD, message: "hello", timeout_s: 0 }, deps),
    ]) as Array<Record<string, unknown>>;
    expect(result.map(({ request_id, status, reply }) => ({ request_id, status, reply }))).toEqual([
      { request_id: FIRST, status: "replied", reply: "first reply" },
      { request_id: SECOND, status: "replied", reply: "second reply" },
    ]);
  });

  test("recovers the full matching historical reply without a live session or process probe", async () => {
    const text = message("user", "unrelated") + message("assistant", "wrong answer") + EVENT_COMPLETE +
      message("user", `[claude-code bridge] [request:${FIRST}]\nhello`) +
      message("assistant", "complete answer") + EVENT_COMPLETE +
      message("user", "later") + message("assistant", "later answer") + EVENT_COMPLETE;
    const { dependencies } = setup("stopped", text, false);
    const result = await callBridgeTool("codex_wait_reply", {
      thread: THREAD, request_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", timeout_s: 0,
    }, { ...dependencies, probeLiveThreads: async () => { throw new Error("must not probe liveness"); } }) as Record<string, unknown>;
    expect({ request_id: result.request_id, status: result.status, reply: result.reply }).toEqual({
      request_id: FIRST, status: "replied", reply: "complete answer",
    });
  });

  test("recovery after a timeout ignores an unrelated turn that completes before delivery", async () => {
    const { path, dependencies } = setup("timeout", message("user", "old question"));
    const deps = { ...dependencies, queueMessage: async () => ({
      queuedId: SECOND, requestId: FIRST,
      framedMessage: `[claude-code bridge] [request:${FIRST}]\nhello`,
    }) };
    const sent = await callBridgeTool("codex_send", { thread: THREAD, message: "hello", timeout_s: 0 }, deps) as Record<string, unknown>;
    expect({ request_id: sent.request_id, status: sent.status }).toEqual({ request_id: FIRST, status: "timeout" });
    const pending = callBridgeTool("codex_wait_reply", { thread: THREAD, request_id: FIRST, timeout_s: 0.2 }, deps);
    setTimeout(() => appendFileSync(path, message("assistant", "unrelated reply") + EVENT_COMPLETE +
      message("user", `[claude-code bridge] [request:${FIRST}]\nhello`) +
      message("assistant", "matching reply") + EVENT_COMPLETE), 10);
    const result = await pending as Record<string, unknown>;
    expect({ status: result.status, reply: result.reply }).toEqual({ status: "replied", reply: "matching reply" });
  });

  test("a quoted marker or UUID prefix cannot claim an unrelated message", async () => {
    const { dependencies } = setup("marker-boundaries",
      message("user", `quoted: [claude-code bridge] [request:${FIRST}]\nhello`) + message("assistant", "quoted answer") + EVENT_COMPLETE +
      message("user", `[claude-code bridge] [request:${FIRST}x]\nhello`) + message("assistant", "prefix answer") + EVENT_COMPLETE +
      message("user", `[claude-code bridge] [request:${FIRST}] same line`) + message("assistant", "invalid marker answer") + EVENT_COMPLETE);
    const result = await callBridgeTool("codex_wait_reply", { thread: THREAD, request_id: FIRST, timeout_s: 0 }, dependencies) as Record<string, unknown>;
    expect({ status: result.status, reply: result.reply }).toEqual({ status: "timeout", reply: "" });
  });

  test("a tail failure preserves the request ID and never sends the message again", async () => {
    const { dependencies } = setup("tail-failure", "");
    let queued = 0;
    await expect(callBridgeTool("codex_send", { thread: THREAD, message: "hello" }, {
      ...dependencies,
      queueMessage: async () => {
        queued += 1;
        return { requestId: FIRST, queuedId: SECOND, framedMessage: `[claude-code bridge] [request:${FIRST}]\nhello` };
      },
      tailRollout: async () => { throw new Error("Synthetic malformed rollout"); },
    })).rejects.toThrow("Synthetic malformed rollout. The message was queued; do not automatically resend. Recover with codex_wait_reply using request_id 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.");
    expect(queued).toBe(1);
  });

  test("a missing completion fails before borrowing a subsequent user's reply", async () => {
    const { path } = setup("missing-completion",
      message("user", `[claude-code bridge] [request:${FIRST}]\nhello`) +
      message("assistant", "unfinished") + message("user", "next question") +
      message("assistant", "unrelated later answer") + EVENT_COMPLETE);
    await expect(tailRollout(path, {
      fromLine: 0, expectedUserText: `[claude-code bridge] [request:${FIRST}]\nhello`, timeoutMs: 0,
    })).rejects.toThrow("before the requested turn completed");
  });

  test("inserting arbitrary complete unrelated turns preserves the recovered answer (seeded)", async () => {
    let seed = 0x145f23;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    let casesWithEarlierAndLaterTurns = 0;
    for (let caseIndex = 0; caseIndex < 40; caseIndex += 1) {
      const beforeCount = 1 + next() % 8;
      const afterCount = 1 + next() % 8;
      const unrelated = () => {
        const body = next() % 2 === 0 ? "unrelated" : `[claude-code bridge] [request:${SECOND}]\nhello`;
        // A marker inside assistant text must not identify a user request.
        return message("user", body) + message("assistant", `[claude-code bridge] [request:${FIRST}]\ndecoy`) + EVENT_COMPLETE;
      };
      const before = Array.from({ length: beforeCount }, unrelated).join("");
      const after = Array.from({ length: afterCount }, unrelated).join("");
      const { dependencies } = setup(`seeded-${caseIndex}`, before +
        message("user", `[claude-code bridge] [request:${FIRST}]\nhello`) +
        message("assistant", "target answer") + EVENT_COMPLETE + after);
      const result = await callBridgeTool("codex_wait_reply", { thread: THREAD, request_id: FIRST, timeout_s: 0 }, dependencies) as Record<string, unknown>;
      expect({ status: result.status, reply: result.reply }).toEqual({ status: "replied", reply: "target answer" });
      if (beforeCount > 0 && afterCount > 0) casesWithEarlierAndLaterTurns += 1;
    }
    expect(casesWithEarlierAndLaterTurns).toBe(40);
  });

  test("invalid recovery IDs and unknown arguments fail before any side effects", async () => {
    let touched = 0;
    const badDependencies = { listSessions: () => { touched += 1; throw new Error("registry touched"); },
      probeLiveThreads: async () => { touched += 1; throw new Error("probe touched"); } };
    for (const requestId of ["", "aaaaaaaa", "../rollout", FIRST + "x", 1, null]) {
      await expect(callBridgeTool("codex_wait_reply", { thread: THREAD, request_id: requestId }, badDependencies)).rejects.toThrow("request_id must be a UUID");
    }
    await expect(callBridgeTool("codex_send", { thread: THREAD, message: "hello", forcee: true }, badDependencies)).rejects.toThrow("Unknown argument: forcee");
    await expect(callBridgeTool("codex_send", { thread: THREAD, message: "hello", timeout_s: 1e308 }, badDependencies)).rejects.toThrow("timeout_s is too large");
    expect(touched).toBe(0);
  });
});
