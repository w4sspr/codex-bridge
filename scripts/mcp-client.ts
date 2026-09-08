import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { version } from "../package.json";

const mode = process.argv[2] ?? "handshake";
const serverPath = join(import.meta.dir, "../server/index.ts");
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", serverPath],
  env: process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {},
  stderr: "inherit",
});
const client = new Client({ name: "codex-bridge-verifier", version });

try {
  await client.connect(transport);

  if (mode === "handshake") {
    const tools = await client.listTools();
    console.log(
      JSON.stringify(
        {
          initialize: {
            serverInfo: client.getServerVersion(),
            capabilities: client.getServerCapabilities(),
          },
          "tools/list": tools,
        },
        null,
        2,
      ),
    );
  } else if (mode === "list") {
    const result = CallToolResultSchema.parse(await client.callTool({
      name: "codex_list_sessions",
      arguments: { live_only: true },
    }));
    const first = result.content[0];
    if (!first || first.type !== "text") {
      throw new Error(`codex_list_sessions returned no text result: ${JSON.stringify(result)}`);
    }
    console.log(first.text);
    if (result.isError) process.exitCode = 1;
  } else if (mode === "smoke") {
    const thread = process.argv[3];
    const message = process.argv[4];
    if (!thread || message === undefined) {
      throw new Error("Usage: bun run scripts/mcp-client.ts smoke <thread> <message>");
    }
    const result = CallToolResultSchema.parse(await client.callTool({
      name: "codex_send",
      arguments: { thread, message, wait: true, timeout_s: 300 },
    }, undefined, { timeout: 335_000 }));
    const first = result.content[0];
    if (!first || first.type !== "text") {
      throw new Error(`codex_send returned no text result: ${JSON.stringify(result)}`);
    }
    console.log(first.text);
    if (result.isError) process.exitCode = 1;
  } else {
    throw new Error(`Unknown verification mode: ${mode}`);
  }
} finally {
  await client.close();
}
