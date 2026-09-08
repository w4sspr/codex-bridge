import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

test("real stdio server isolates the selected home and keeps serving after invalid requests", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-bridge-mcp-"));
  const id = "11111111-1111-4111-8111-111111111111";
  mkdirSync(join(home, "sessions"));
  writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({
    id, thread_name: "isolated-test", updated_at: "2026-01-01T00:00:00Z",
  }) + "\n");
  writeFileSync(join(home, "sessions", `rollout-${id}.jsonl`),
    '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"synthetic response"}]}}\n');
  const client = new Client({ name: "bridge-integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "index.ts")],
    env: { CODEX_HOME: home },
    stderr: "inherit",
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 2_000 }));
  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({ name: "codex-bridge", version: "0.3.0" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "codex_list_sessions", "codex_send", "codex_wait_reply", "codex_read_transcript",
    ]);
    const invalid = await call("codex_send", { thread: "isolated-test", message: 7 });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toEqual([{ type: "text", text: "message must be a string" }]);
    const unknown = await call("not_a_tool", {});
    expect(unknown.isError).toBe(true);
    const transcript = await call("codex_read_transcript", { thread: "isolated-test", last_n: 1 });
    expect(transcript.isError).toBeUndefined();
    expect(transcript.content).toEqual([{
      type: "text", text: '[\n  {\n    "role": "assistant",\n    "text": "synthetic response"\n  }\n]',
    }]);
  } finally {
    await client.close();
    Bun.spawnSync(["trash", home]);
  }
});
