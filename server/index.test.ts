import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBridgeTool, TOOL_DEFINITIONS } from "./index";
import type { SessionRecord } from "./lib/registry";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) Bun.spawnSync(["trash", directory]);
});

function testSession(
  id: string,
  name: string,
  rolloutPath: string,
  live: boolean,
  pid: number | null,
): SessionRecord {
  return {
    id,
    name,
    title: name,
    cwd: "/work",
    updated_at: "2026-09-06T12:00:00.000Z",
    rollout_path: rolloutPath,
    rollout_exists: true,
    live,
    pid,
  };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("MCP tool surface", () => {
  test("exposes exactly the four planned tools with wait defaults", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "codex_list_sessions",
      "codex_send",
      "codex_wait_reply",
      "codex_read_transcript",
    ]);

    const send = TOOL_DEFINITIONS[1];
    expect(send?.inputSchema.properties?.wait).toEqual({ type: "boolean", default: true });
    expect(send?.inputSchema.properties?.timeout_s).toEqual({
      type: "number",
      minimum: 0,
      default: 300,
    });
    expect(send?.inputSchema.properties?.force).toEqual({ type: "boolean", default: false });

    const list = TOOL_DEFINITIONS[0];
    expect(list?.inputSchema.properties?.live_only).toEqual({
      type: "boolean",
      default: false,
    });
  });

  test("refuses a non-live send with at most three live alternatives and force bypasses it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-bridge-send-"));
    temporaryDirectories.push(directory);
    const rolloutPath = join(directory, "rollout.jsonl");
    writeFileSync(rolloutPath, '{"type":"session_meta"}\n');
    const sessions = [
      testSession("dead-id", "dead", rolloutPath, false, null),
      testSession("live-1", "one", rolloutPath, true, 101),
      testSession("live-2", "two", rolloutPath, true, 102),
      testSession("live-3", "three", rolloutPath, true, 103),
      testSession("live-4", "four", rolloutPath, true, 104),
    ];
    const queuedCalls: Array<[string, string]> = [];
    const tailCalls: Array<[string, unknown]> = [];
    const dependencies = {
      listSessions: () => sessions,
      probeLiveThreads: async () =>
        new Map(
          sessions.flatMap((item) =>
            item.pid === null ? [] : [[item.id, item.pid] as const],
          ),
        ),
      queueMessage: async (thread: string, message: string) => {
        queuedCalls.push([thread, message]);
        return {
          queuedId: "123e4567-e89b-12d3-a456-426614174000",
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          framedMessage: `[claude-code bridge] [request:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]\n${message}`,
        };
      },
      tailRollout: async (path: string, options: unknown) => {
        tailCalls.push([path, options]);
        return {
          status: "replied" as const,
          reply: "live reply",
          elapsed_ms: 35,
          tool_calls_seen: 2,
        };
      },
      now: (() => {
        const values = [1_000, 1_025, 2_000, 2_040];
        return () => values.shift()!;
      })(),
    };

    const refusal = await rejectionMessage(
      callBridgeTool(
        "codex_send",
        { thread: "dead", message: "hello", wait: false },
        dependencies,
      ),
    );
    expect(refusal).toBe(
      "Codex session 'dead-id' has no running Codex process. The message would queue with no reply.\nLive sessions:\n- live-1 (one)\n- live-2 (two)\n- live-3 (three)",
    );
    expect(queuedCalls).toEqual([]);

    expect(
      await callBridgeTool(
        "codex_send",
        { thread: "dead", message: "hello", wait: false, force: true },
        dependencies,
      ),
    ).toEqual({
      queued_id: "123e4567-e89b-12d3-a456-426614174000",
      request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "queued",
      reply: "",
      elapsed_ms: 25,
      tool_calls_seen: 0,
    });
    expect(
      await callBridgeTool(
        "codex_send",
        { thread: "one", message: "live question", wait: true, timeout_s: 7 },
        dependencies,
      ),
    ).toEqual({
      queued_id: "123e4567-e89b-12d3-a456-426614174000",
      request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "replied",
      reply: "live reply",
      elapsed_ms: 40,
      tool_calls_seen: 2,
    });
    expect(queuedCalls).toEqual([
      ["dead-id", "hello"],
      ["live-1", "live question"],
    ]);
    expect(tailCalls).toEqual([
      [
        rolloutPath,
        {
          fromLine: 1,
          expectedUserText: "[claude-code bridge] [request:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]\nlive question",
          timeoutMs: 7_000,
        },
      ],
    ]);
  });

  test("refuses to wait on a non-live session before starting a rollout tail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-bridge-wait-"));
    temporaryDirectories.push(directory);
    const rolloutPath = join(directory, "rollout.jsonl");
    writeFileSync(rolloutPath, '{"type":"session_meta"}\n');
    const dead = testSession("dead-wait", "stopped", rolloutPath, false, null);
    let tailCalls = 0;

    const refusal = await rejectionMessage(
      callBridgeTool(
        "codex_wait_reply",
        { thread: "stopped", timeout_s: 0 },
        {
          listSessions: () => [dead],
          probeLiveThreads: async () => new Map(),
          tailRollout: async () => {
            tailCalls += 1;
            return {
              status: "timeout" as const,
              reply: "",
              elapsed_ms: 0,
              tool_calls_seen: 0,
            };
          },
        },
      ),
    );
    expect(refusal).toBe(
      "Codex session 'dead-wait' has no running Codex process. The message would queue with no reply.\nNo live Codex sessions are available.",
    );
    expect(tailCalls).toBe(0);
  });
});
