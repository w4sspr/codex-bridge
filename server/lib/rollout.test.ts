import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  countRolloutLines,
  extractReplyFromText,
  readTranscript,
  tailRollout,
} from "./rollout";

const fixturePath = join(import.meta.dir, "../fixtures/three-turns.jsonl");
const fixture = readFileSync(fixturePath, "utf8");
const queuedMessage = "Compare two retry strategies.";
const finalReply = "Use bounded retries with a request identifier.";

const temporaryPaths: string[] = [];

afterAll(() => {
  for (const path of temporaryPaths) Bun.spawnSync(["trash", path]);
});

describe("rollout parsing", () => {
  test("returns only assistant text after the matching queued message", () => {
    expect(extractReplyFromText(fixture, queuedMessage)).toEqual({
      status: "replied",
      reply:
        "Checking the synthetic example.\n" + finalReply,
      tool_calls_seen: 0,
      message_seen: true,
    });
  });

  test("keeps partial assistant text queued until task_complete arrives", () => {
    const pending = fixture.split("\n").slice(0, 11).join("\n");

    expect(extractReplyFromText(pending, queuedMessage)).toEqual({
      status: "queued",
      reply: "Checking the synthetic example.\n",
      tool_calls_seen: 0,
      message_seen: true,
    });
  });

  test("reports turn_aborted without borrowing text from prior turns", () => {
    const throughQueuedMessage = fixture.split("\n").slice(0, 10).join("\n");
    const aborted = `${throughQueuedMessage}\n{"type":"event_msg","payload":{"type":"turn_aborted"}}`;

    expect(extractReplyFromText(aborted, queuedMessage)).toEqual({
      status: "aborted",
      reply: "",
      tool_calls_seen: 0,
      message_seen: true,
    });
  });

  test("ignores unknown record types but rejects a recognized record missing payload", () => {
    expect(
      extractReplyFromText('{"type":"future_rollout_shape","data":42}\n', queuedMessage),
    ).toEqual({
      status: "queued",
      reply: "",
      tool_calls_seen: 0,
      message_seen: false,
    });

    expect(() => extractReplyFromText('{"type":"response_item"}\n', queuedMessage)).toThrow(
      "Malformed rollout line 1: response_item is missing payload",
    );
  });

  test("counts tool calls only after the matching queued message", () => {
    const text = [
      '{"type":"response_item","payload":{"type":"custom_tool_call","name":"old"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"target"}]}}',
      '{"type":"response_item","payload":{"type":"custom_tool_call","name":"new"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
      '{"type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n");

    expect(extractReplyFromText(text, "target")).toEqual({
      status: "replied",
      reply: "done",
      tool_calls_seen: 1,
      message_seen: true,
    });
  });

  test("returns the last N user and assistant messages in source order", () => {
    expect(readTranscript(fixturePath, 3)).toEqual([
      { role: "user", text: queuedMessage },
      {
        role: "assistant",
        text: "Checking the synthetic example.\n",
      },
      { role: "assistant", text: finalReply },
    ]);
  });
});

describe("live rollout tailing", () => {
  test("observes lines appended after waiting begins", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-bridge-tail-"));
    const path = join(directory, "rollout.jsonl");
    temporaryPaths.push(path);
    writeFileSync(
      path,
      [
        '{"type":"event_msg","payload":{"type":"task_started"}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"target"}]}}',
        "",
      ].join("\n"),
    );

    setTimeout(() => {
      appendFileSync(
        path,
        [
          '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"arrived later"}]}}',
          '{"type":"event_msg","payload":{"type":"task_complete"}}',
          "",
        ].join("\n"),
      );
    }, 25);

    const result = await tailRollout(path, {
      fromLine: 0,
      expectedUserText: "target",
      timeoutMs: 500,
      pollIntervalMs: 5,
    });

    expect(result.status).toBe("replied");
    expect(result.reply).toBe("arrived later");
    expect(result.tool_calls_seen).toBe(0);
  });

  test("timeout returns assistant text accumulated so far", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-bridge-timeout-"));
    const path = join(directory, "rollout.jsonl");
    temporaryPaths.push(path);
    writeFileSync(
      path,
      [
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"target"}]}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}}',
        "",
      ].join("\n"),
    );

    const result = await tailRollout(path, {
      fromLine: 0,
      expectedUserText: "target",
      timeoutMs: 40,
      pollIntervalMs: 5,
    });

    expect(result.status).toBe("timeout");
    expect(result.reply).toBe("partial");
    expect(result.tool_calls_seen).toBe(0);
  });

  test("line counting excludes a final unterminated fragment", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-bridge-count-"));
    const path = join(directory, "rollout.jsonl");
    temporaryPaths.push(path);
    writeFileSync(path, '{"type":"session_meta"}\n{"type":"event_msg"}');

    expect(countRolloutLines(path)).toBe(1);
  });
});
