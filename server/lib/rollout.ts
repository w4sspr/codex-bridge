import { existsSync, readFileSync } from "node:fs";
import { requestMarker } from "./queue";

export type ReplyStatus = "replied" | "aborted" | "timeout" | "queued";

export type ReplyExtraction = {
  status: Exclude<ReplyStatus, "timeout">;
  reply: string;
  tool_calls_seen: number;
  message_seen: boolean;
};

export type TailResult = {
  status: Exclude<ReplyStatus, "queued">;
  reply: string;
  elapsed_ms: number;
  tool_calls_seen: number;
};

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
};

type JsonRecord = Record<string, unknown>;

const TOOL_CALL_TYPES = new Set([
  "custom_tool_call",
  "function_call",
  "local_shell_call",
  "web_search_call",
  "computer_call",
  "mcp_tool_call",
]);

function parseLine(line: string, lineNumber: number): JsonRecord | null {
  if (!line.trim()) return null;

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid rollout JSON on line ${lineNumber}: ${detail}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Malformed rollout line ${lineNumber}: expected a JSON object`);
  }

  const record = value as JsonRecord;
  if (record.type !== "response_item" && record.type !== "event_msg") return record;
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    throw new Error(`Malformed rollout line ${lineNumber}: ${record.type} is missing payload`);
  }
  return record;
}

function payloadFor(record: JsonRecord): JsonRecord | null {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as JsonRecord)
    : null;
}

function messageText(payload: JsonRecord, lineNumber: number): string {
  const content = payload.content;
  if (!Array.isArray(content)) {
    throw new Error(`Malformed rollout line ${lineNumber}: message is missing content`);
  }

  const text: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const typed = item as JsonRecord;
    if (typed.type !== "input_text" && typed.type !== "output_text") continue;
    if (typeof typed.text !== "string") {
      throw new Error(`Malformed rollout line ${lineNumber}: text content is missing text`);
    }
    text.push(typed.text);
  }
  return text.join("");
}

class ReplyAccumulator {
  readonly expectedUserText: string | null;
  readonly expectedRequestMarker: string | null;
  messageSeen: boolean;
  status: "queued" | "replied" | "aborted" = "queued";
  reply = "";
  toolCallsSeen = 0;

  constructor(expectedUserText: string | null, expectedRequestId?: string) {
    this.expectedUserText = expectedUserText;
    this.expectedRequestMarker = expectedRequestId === undefined ? null : requestMarker(expectedRequestId);
    this.messageSeen = expectedUserText === null && this.expectedRequestMarker === null;
  }

  accept(record: JsonRecord, lineNumber: number): void {
    const payload = payloadFor(record);
    if (!payload) return;

    if (!this.messageSeen) {
      if (
        record.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "user"
      ) {
        const text = messageText(payload, lineNumber);
        this.messageSeen = this.expectedRequestMarker === null
          ? text === this.expectedUserText
          : text.startsWith(this.expectedRequestMarker);
      }
      return;
    }

    if (
      (this.expectedUserText !== null || this.expectedRequestMarker !== null) &&
      ((record.type === "response_item" && payload.type === "message" && payload.role === "user") ||
        (record.type === "event_msg" && payload.type === "task_started"))
    ) {
      throw new Error(
        "Codex started another turn before the requested turn completed; refusing to return an unrelated reply.",
      );
    }

    if (record.type === "event_msg") {
      if (payload.type === "task_complete") this.status = "replied";
      if (payload.type === "turn_aborted") this.status = "aborted";
      return;
    }

    if (record.type !== "response_item") return;
    if (payload.type === "message" && payload.role === "assistant") {
      this.reply += messageText(payload, lineNumber);
    } else if (typeof payload.type === "string" && TOOL_CALL_TYPES.has(payload.type)) {
      this.toolCallsSeen += 1;
    }
  }

  extraction(): ReplyExtraction {
    return {
      status: this.status,
      reply: this.reply,
      tool_calls_seen: this.toolCallsSeen,
      message_seen: this.messageSeen,
    };
  }
}

function allLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function completeLines(text: string): string[] {
  const lines = text.split("\n");
  lines.pop();
  return lines;
}

export function extractReplyFromText(text: string, expectedUserText: string): ReplyExtraction {
  const accumulator = new ReplyAccumulator(expectedUserText);
  allLines(text).forEach((line, index) => {
    if (accumulator.status !== "queued") return;
    const record = parseLine(line, index + 1);
    if (record) accumulator.accept(record, index + 1);
  });
  return accumulator.extraction();
}

export function countRolloutLines(path: string): number {
  if (!existsSync(path)) return 0;
  return completeLines(readFileSync(path, "utf8")).length;
}

export type TailOptions = {
  fromLine: number;
  expectedUserText?: string;
  expectedRequestId?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
};

export async function tailRollout(path: string, options: TailOptions): Promise<TailResult> {
  if (!Number.isInteger(options.fromLine) || options.fromLine < 0) {
    throw new Error(`Rollout line offset must be a non-negative integer; received ${options.fromLine}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error(`Rollout timeout must be a non-negative number; received ${options.timeoutMs}`);
  }

  const startedAt = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const accumulator = new ReplyAccumulator(options.expectedUserText ?? null, options.expectedRequestId);
  let cursor = options.fromLine;

  while (true) {
    if (!existsSync(path)) throw new Error(`Codex rollout does not exist: ${path}`);
    const lines = completeLines(readFileSync(path, "utf8"));
    if (lines.length < cursor) {
      throw new Error(`Codex rollout was truncated while waiting: ${path}`);
    }

    for (let index = cursor; index < lines.length; index += 1) {
      const record = parseLine(lines[index]!, index + 1);
      if (record) accumulator.accept(record, index + 1);
      if (accumulator.status !== "queued") {
        return {
          status: accumulator.status,
          reply: accumulator.reply,
          elapsed_ms: Date.now() - startedAt,
          tool_calls_seen: accumulator.toolCallsSeen,
        };
      }
    }
    cursor = lines.length;

    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.timeoutMs) {
      return {
        status: "timeout",
        reply: accumulator.reply,
        elapsed_ms: elapsed,
        tool_calls_seen: accumulator.toolCallsSeen,
      };
    }
    await Bun.sleep(Math.min(pollIntervalMs, options.timeoutMs - elapsed));
  }
}

export function readTranscript(path: string, lastN = 10): TranscriptMessage[] {
  if (!Number.isInteger(lastN) || lastN < 0) {
    throw new Error(`Transcript message count must be a non-negative integer; received ${lastN}`);
  }
  if (!existsSync(path)) throw new Error(`Codex rollout does not exist: ${path}`);

  const messages: TranscriptMessage[] = [];
  const lines = completeLines(readFileSync(path, "utf8"));
  lines.forEach((line, index) => {
    const record = parseLine(line, index + 1);
    if (!record || record.type !== "response_item") return;
    const payload = payloadFor(record);
    if (
      !payload ||
      payload.type !== "message" ||
      (payload.role !== "user" && payload.role !== "assistant")
    ) {
      return;
    }
    messages.push({
      role: payload.role,
      text: messageText(payload, index + 1),
    });
  });
  return lastN === 0 ? [] : messages.slice(-lastN);
}
