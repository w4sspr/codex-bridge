import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { codexHomeFromSystem } from "./config";

export type SessionRecord = {
  id: string;
  name: string | null;
  title: string;
  cwd: string;
  updated_at: string;
  rollout_path: string;
  rollout_exists: boolean;
  live: boolean;
  pid: number | null;
};

type SqliteThread = {
  id: string;
  name: string | null;
  title: string;
  cwd: string;
  updated_at: number;
  rollout_path: string;
};

type SessionIndexLine = {
  id: string;
  thread_name: string;
  updated_at: string;
};

export type ListSessionsOptions = {
  codexHome?: string;
  limit?: number;
  includeArchived?: boolean;
  liveThreads?: ReadonlyMap<string, number>;
  liveOnly?: boolean;
};

const DEFAULT_LIMIT = 20;

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Session limit must be a non-negative integer; received ${limit}`);
  }
}

function truncateTitle(title: string): string {
  return Array.from(title).slice(0, 80).join("");
}

function highestStateDatabase(codexHome: string): string | null {
  if (!existsSync(codexHome)) return null;

  let selected: { number: bigint; path: string } | null = null;
  for (const entry of readdirSync(codexHome)) {
    const match = /^state_(\d+)\.sqlite$/.exec(entry);
    if (!match) continue;
    const number = BigInt(match[1]!);
    if (!selected || number > selected.number) {
      selected = { number, path: join(codexHome, entry) };
    }
  }
  return selected?.path ?? null;
}

function isoFromMilliseconds(milliseconds: number): string {
  const date = new Date(milliseconds);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Codex registry contains an invalid timestamp: ${milliseconds}`);
  }
  return date.toISOString();
}

function isCannotOpen(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "SQLITE_CANTOPEN" || (typeof message === "string" && message.includes("unable to open database file"));
}

function sqliteUri(path: string): string {
  return `file:${path.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23")}`;
}

// Codex opens its registry in WAL mode and SQLite deletes the -wal/-shm
// sidecars when the last connection closes. A read-only open of that idle
// state fails with SQLITE_CANTOPEN because SQLite may not create the sidecars.
// With no -wal present the main file is complete, so read it as immutable.
function openRegistry(databasePath: string): Database {
  const database = new Database(databasePath, { readonly: true });
  try {
    // Bun opens lazily; the first statement is where SQLITE_CANTOPEN surfaces.
    database.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return database;
  } catch (error) {
    database.close();
    if (!isCannotOpen(error) || existsSync(`${databasePath}-wal`)) throw error;
    return new Database(`${sqliteUri(databasePath)}?immutable=1`, { readonly: true });
  }
}

function listFromSqlite(
  databasePath: string,
  limit: number | null,
  includeArchived: boolean,
): SessionRecord[] {
  if (limit === 0) return [];

  const database = openRegistry(databasePath);
  try {
    const rows = database
      .query<SqliteThread, [number, number]>(`
        SELECT
          id,
          name,
          title,
          cwd,
          updated_at,
          rollout_path
        FROM threads
        WHERE (?1 = 1 OR archived = 0)
        ORDER BY updated_at DESC, id DESC
        LIMIT ?2
      `)
      .all(includeArchived ? 1 : 0, limit ?? -1);

    return rows.map((row) => {
      return {
        id: row.id,
        name: row.name,
        title: truncateTitle(row.title),
        cwd: row.cwd,
        updated_at: isoFromMilliseconds(row.updated_at * 1000),
        rollout_path: row.rollout_path,
        rollout_exists: existsSync(row.rollout_path),
        live: false,
        pid: null,
      };
    });
  } finally {
    database.close();
  }
}

function findFallbackRollout(codexHome: string, id: string): string {
  const sessionsRoot = join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return "";

  const matches = Array.from(
    new Bun.Glob("**/*.jsonl").scanSync({ cwd: sessionsRoot, onlyFiles: true }),
  )
    .filter((relativePath) => basename(relativePath).includes(id))
    .sort();
  const selected = matches.at(-1);
  return selected ? join(sessionsRoot, selected) : "";
}

function parseIndexLine(line: string, lineNumber: number): SessionIndexLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex session index JSON on line ${lineNumber}: ${detail}`);
  }

  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).id !== "string" ||
    typeof (value as Record<string, unknown>).thread_name !== "string" ||
    typeof (value as Record<string, unknown>).updated_at !== "string"
  ) {
    throw new Error(
      `Malformed Codex session index line ${lineNumber}: expected id, thread_name, and updated_at strings`,
    );
  }
  return value as SessionIndexLine;
}

function listFromIndex(codexHome: string, limit: number | null): SessionRecord[] {
  if (limit === 0) return [];
  const indexPath = join(codexHome, "session_index.jsonl");
  if (!existsSync(indexPath)) return [];

  const latestById = new Map<string, SessionIndexLine>();
  const lines = readFileSync(indexPath, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const parsed = parseIndexLine(line, index + 1);
    const prior = latestById.get(parsed.id);
    if (!prior || Date.parse(parsed.updated_at) >= Date.parse(prior.updated_at)) {
      latestById.set(parsed.id, parsed);
    }
  });

  return Array.from(latestById.values())
    .map((line) => {
      const milliseconds = Date.parse(line.updated_at);
      if (Number.isNaN(milliseconds)) {
        throw new Error(
          `Codex session index contains an invalid timestamp for ${line.id}: ${line.updated_at}`,
        );
      }
      const rolloutPath = findFallbackRollout(codexHome, line.id);
      return {
        id: line.id,
        name: line.thread_name || null,
        title: truncateTitle(line.thread_name),
        cwd: "",
        updated_at: isoFromMilliseconds(milliseconds),
        rollout_path: rolloutPath,
        rollout_exists: rolloutPath !== "" && existsSync(rolloutPath),
        live: false,
        pid: null,
      } satisfies SessionRecord;
    })
    .sort((left, right) => {
      const timeDifference = Date.parse(right.updated_at) - Date.parse(left.updated_at);
      return timeDifference || right.id.localeCompare(left.id);
    })
    .slice(0, limit ?? undefined);
}

export function listSessions(options: ListSessionsOptions = {}): SessionRecord[] {
  const codexHome = options.codexHome ?? codexHomeFromSystem();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const includeArchived = options.includeArchived ?? false;
  const liveThreads = options.liveThreads ?? new Map<string, number>();
  const liveOnly = options.liveOnly ?? false;
  validateLimit(limit);
  if (limit === 0) return [];

  const databasePath = highestStateDatabase(codexHome);
  const sourceLimit = liveOnly ? null : limit;
  const sessions = databasePath
    ? listFromSqlite(databasePath, sourceLimit, includeArchived)
    : listFromIndex(codexHome, sourceLimit);
  const withLiveness = sessions.map((session) => {
    const pid = liveThreads.get(session.id) ?? liveThreads.get(session.id.toLowerCase()) ?? null;
    return { ...session, live: pid !== null, pid };
  });
  return liveOnly ? withLiveness.filter((session) => session.live).slice(0, limit) : withLiveness;
}

function ambiguityError(thread: string, candidates: SessionRecord[]): Error {
  const lines = candidates
    .map((candidate) => `- ${candidate.id} (${candidate.name ?? "unnamed"})`)
    .join("\n");
  return new Error(`Ambiguous Codex session '${thread}'. Candidates:\n${lines}`);
}

export function resolveSessionFrom(
  sessions: SessionRecord[],
  thread: string,
): SessionRecord {
  const normalizedThread = thread.toLowerCase();
  const exactId = sessions.find((session) => session.id.toLowerCase() === normalizedThread);
  if (exactId) return exactId;

  const exactNames = sessions.filter((session) => session.name === thread);
  if (exactNames.length === 1) return exactNames[0]!;
  if (exactNames.length > 1) throw ambiguityError(thread, exactNames);

  const prefixMatches = sessions.filter((session) =>
    session.id.toLowerCase().startsWith(normalizedThread),
  );
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  if (prefixMatches.length > 1) throw ambiguityError(thread, prefixMatches);

  throw new Error(`No Codex session matches '${thread}'. Run codex_list_sessions to see targets.`);
}

export function resolveSession(
  thread: string,
  options: Pick<ListSessionsOptions, "codexHome"> = {},
): SessionRecord {
  if (!thread.trim()) throw new Error("Codex session target must not be empty");
  return resolveSessionFrom(
    listSessions({ codexHome: options.codexHome, includeArchived: true, limit: 1_000_000 }),
    thread,
  );
}
