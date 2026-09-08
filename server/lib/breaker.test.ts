import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PREFIX, frameMessage } from "./queue";
import { listSessions, resolveSessionFrom, type SessionRecord } from "./registry";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    Bun.spawnSync(["trash", directory]);
  }
});

function databaseWithSession(path: string, id: string): void {
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT NOT NULL,
        name TEXT,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        recency_at_ms INTEGER NOT NULL,
        rollout_path TEXT NOT NULL,
        archived INTEGER NOT NULL
      )
    `);
    database
      .query(`
        INSERT INTO threads (
          id, name, title, cwd, updated_at, recency_at_ms, rollout_path, archived
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `)
      .run(id, null, id, "/fixture", 1, 1_000, "/fixture/rollout.jsonl", 0);
  } finally {
    database.close();
  }
}

describe("independent breaker cases", () => {
  test("normalizes repeated leading bridge headers to exactly one", () => {
    expect(frameMessage(`${BRIDGE_PREFIX}${BRIDGE_PREFIX}payload`)).toBe(
      `${BRIDGE_PREFIX}payload`,
    );
  });

  test("selects the numerically highest state database beyond MAX_SAFE_INTEGER", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-bridge-breaker-"));
    temporaryDirectories.push(codexHome);

    databaseWithSession(
      join(codexHome, "state_9007199254740992.sqlite"),
      "00000000-0000-0000-0000-000000000092",
    );
    databaseWithSession(
      join(codexHome, "state_9007199254740993.sqlite"),
      "00000000-0000-0000-0000-000000000093",
    );

    expect(listSessions({ codexHome, includeArchived: true }).map((session) => session.id)).toEqual([
      "00000000-0000-0000-0000-000000000093",
    ]);
  });

  test("resolves UUIDs and UUID prefixes with uppercase hexadecimal digits", () => {
    const session: SessionRecord = {
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      name: null,
      title: "fixture",
      cwd: "/fixture",
      updated_at: "2026-09-06T00:00:00.000Z",
      rollout_path: "/fixture/rollout.jsonl",
      rollout_exists: false,
      live: false,
      pid: null,
    };

    expect(resolveSessionFrom([session], "ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(session);
    expect(resolveSessionFrom([session], "ABCDEF12")).toBe(session);
  });
});
