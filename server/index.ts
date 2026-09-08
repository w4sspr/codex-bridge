import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import { codexHomeFromSystem } from "./lib/config";
import { probeLiveThreads } from "./lib/liveness";
import {
  listSessions,
  resolveSession,
  resolveSessionFrom,
  type SessionRecord,
} from "./lib/registry";
import { queueMessage, validateRequestId } from "./lib/queue";
import { countRolloutLines, readTranscript, tailRollout } from "./lib/rollout";

const FIRST_MESSAGE_ERROR =
  "This Codex session has not been persisted yet. Type a first message in that Codex window, then try again.";

export const TOOL_DEFINITIONS = [
  {
    name: "codex_list_sessions",
    description: "List persisted Codex CLI sessions with live process status, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 0, default: 20 },
        include_archived: { type: "boolean", default: false },
        live_only: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_send",
    description: "Queue one message to a Codex CLI session and optionally wait for its reply.",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          minLength: 1,
          description: "Full UUID, unique UUID prefix, or exact session name.",
        },
        message: { type: "string" },
        wait: { type: "boolean", default: true },
        timeout_s: { type: "number", minimum: 0, default: 300 },
        force: { type: "boolean", default: false },
      },
      required: ["thread", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_wait_reply",
    description: "Recover a specific request by request_id, including after timeout or restart. Without request_id, wait for any next turn completion from the current rollout end.",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          minLength: 1,
          description: "Full UUID, unique UUID prefix, or exact session name.",
        },
        timeout_s: { type: "number", minimum: 0, default: 300 },
        request_id: {
          type: "string",
          format: "uuid",
          description: "Request UUID returned by codex_send. Recovers its full matching reply, including from a stopped session.",
        },
      },
      required: ["thread"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_read_transcript",
    description: "Read the last N user and assistant messages from a Codex rollout.",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          minLength: 1,
          description: "Full UUID, unique UUID prefix, or exact session name.",
        },
        last_n: { type: "integer", minimum: 0, default: 10 },
      },
      required: ["thread"],
      additionalProperties: false,
    },
  },
] as const;

type ToolArguments = Record<string, unknown>;

function argumentsObject(value: unknown): ToolArguments {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return value as ToolArguments;
}

function stringArgument(arguments_: ToolArguments, name: string): string {
  const value = arguments_[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (name === "thread" && !value.trim()) throw new Error("thread must not be empty");
  return value;
}

function booleanArgument(arguments_: ToolArguments, name: string, fallback: boolean): boolean {
  const value = arguments_[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function numberArgument(
  arguments_: ToolArguments,
  name: string,
  fallback: number,
  integer: boolean,
): number {
  const value = arguments_[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  if (integer && !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  if (name === "timeout_s" && !Number.isFinite(value * 1000)) throw new Error("timeout_s is too large");
  return value;
}

function requireRollout(session: ReturnType<typeof resolveSession>): string {
  if (!session.rollout_path || !existsSync(session.rollout_path)) throw new Error(FIRST_MESSAGE_ERROR);
  return session.rollout_path;
}

type BridgeDependencies = {
  listSessions: typeof listSessions;
  probeLiveThreads: typeof probeLiveThreads;
  queueMessage: typeof queueMessage;
  tailRollout: typeof tailRollout;
  now: () => number;
};

const DEFAULT_DEPENDENCIES: BridgeDependencies = {
  listSessions,
  probeLiveThreads,
  queueMessage,
  tailRollout,
  now: Date.now,
};

async function sessionsWithLiveness(dependencies: BridgeDependencies): Promise<SessionRecord[]> {
  const liveThreads = await dependencies.probeLiveThreads(join(codexHomeFromSystem(), "thread-writer-locks"));
  return dependencies.listSessions({
    includeArchived: true,
    limit: 1_000_000,
    liveThreads,
  });
}

function requireLiveSession(session: SessionRecord, sessions: SessionRecord[]): void {
  if (session.live) return;

  const alternatives = sessions.filter((candidate) => candidate.live).slice(0, 3);
  const guidance = alternatives.length === 0
    ? "No live Codex sessions are available."
    : `Live sessions:\n${alternatives
      .map((candidate) => `- ${candidate.id} (${candidate.name ?? "unnamed"})`)
      .join("\n")}`;
  throw new Error(
    `Codex session '${session.id}' has no running Codex process. ` +
      `The message would queue with no reply.\n${guidance}`,
  );
}

export async function callBridgeTool(
  name: string,
  rawArguments: unknown,
  dependencyOverrides: Partial<BridgeDependencies> = {},
): Promise<unknown> {
  const arguments_ = argumentsObject(rawArguments);
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  for (const key of Object.keys(arguments_)) {
    if (!Object.hasOwn(definition.inputSchema.properties, key)) throw new Error(`Unknown argument: ${key}`);
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  switch (name) {
    case "codex_list_sessions": {
      const limit = numberArgument(arguments_, "limit", 20, true);
      const includeArchived = booleanArgument(arguments_, "include_archived", false);
      const liveOnly = booleanArgument(arguments_, "live_only", false);
      const liveThreads = await dependencies.probeLiveThreads(join(codexHomeFromSystem(), "thread-writer-locks"));
      return dependencies.listSessions({ limit, includeArchived, liveOnly, liveThreads });
    }

    case "codex_send": {
      const thread = stringArgument(arguments_, "thread");
      const message = stringArgument(arguments_, "message");
      const wait = booleanArgument(arguments_, "wait", true);
      const timeoutSeconds = numberArgument(arguments_, "timeout_s", 300, false);
      const force = booleanArgument(arguments_, "force", false);
      const sessions = await sessionsWithLiveness(dependencies);
      const session = resolveSessionFrom(sessions, thread);
      if (!force) requireLiveSession(session, sessions);
      const rolloutPath = requireRollout(session);
      const fromLine = countRolloutLines(rolloutPath);
      const startedAt = dependencies.now();
      const queued = await dependencies.queueMessage(session.id, message);

      if (!wait) {
        return {
          queued_id: queued.queuedId,
          request_id: queued.requestId,
          status: "queued",
          reply: "",
          elapsed_ms: dependencies.now() - startedAt,
          tool_calls_seen: 0,
        };
      }

      let result: Awaited<ReturnType<typeof tailRollout>>;
      try {
        result = await dependencies.tailRollout(rolloutPath, {
          fromLine,
          expectedUserText: queued.framedMessage,
          timeoutMs: timeoutSeconds * 1000,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}. The message was queued; do not automatically resend. ` +
          `Recover with codex_wait_reply using request_id '${queued.requestId}'.`);
      }
      return {
        queued_id: queued.queuedId,
        request_id: queued.requestId,
        status: result.status,
        reply: result.reply,
        elapsed_ms: dependencies.now() - startedAt,
        tool_calls_seen: result.tool_calls_seen,
      };
    }

    case "codex_wait_reply": {
      const thread = stringArgument(arguments_, "thread");
      const timeoutSeconds = numberArgument(arguments_, "timeout_s", 300, false);
      if (arguments_.request_id !== undefined) {
        const requestId = validateRequestId(arguments_.request_id);
        const session = resolveSessionFrom(
          dependencies.listSessions({ includeArchived: true, limit: 1_000_000 }), thread,
        );
        const result = await dependencies.tailRollout(requireRollout(session), {
          fromLine: 0,
          expectedRequestId: requestId,
          timeoutMs: timeoutSeconds * 1000,
        });
        return { request_id: requestId, ...result };
      }
      const sessions = await sessionsWithLiveness(dependencies);
      const session = resolveSessionFrom(sessions, thread);
      requireLiveSession(session, sessions);
      const rolloutPath = requireRollout(session);
      return dependencies.tailRollout(rolloutPath, {
        fromLine: countRolloutLines(rolloutPath),
        timeoutMs: timeoutSeconds * 1000,
      });
    }

    case "codex_read_transcript": {
      const thread = stringArgument(arguments_, "thread");
      const lastN = numberArgument(arguments_, "last_n", 10, true);
      const session = resolveSession(thread);
      return readTranscript(requireRollout(session), lastN);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createServer(): Server {
  const server = new Server(
    { name: "codex-bridge", version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOL_DEFINITIONS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return jsonContent(
        await callBridgeTool(request.params.name, request.params.arguments),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  });
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await main();
}
