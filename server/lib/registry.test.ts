import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSessions,
  resolveSessionFrom,
  type SessionRecord,
} from "./registry";
import { parseLsofOutput } from "./liveness";

type Row = {
  id: string;
  rollout_path: string;
  updated_at: number;
  cwd: string;
  title: string;
  name: string | null;
  archived: number;
  recency_at_ms: number;
};

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) Bun.spawnSync(["trash", directory]);
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-bridge-registry-"));
  temporaryDirectories.push(home);
  return home;
}

function createState(home: string, number: number, rows: Row[], journalMode = "delete"): void {
  const database = new Database(join(home, `state_${number}.sqlite`), { create: true });
  database.run(`PRAGMA journal_mode=${journalMode}`);
  database.run(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      name TEXT,
      archived INTEGER NOT NULL,
      recency_at_ms INTEGER NOT NULL
    )
  `);
  const insert = database.query(
    "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.rollout_path,
      row.updated_at,
      row.cwd,
      row.title,
      row.name,
      row.archived,
      row.recency_at_ms,
    );
  }
  database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
}

function session(overrides: Partial<SessionRecord> & Pick<SessionRecord, "id">): SessionRecord {
  return {
    id: overrides.id,
    name: overrides.name ?? null,
    title: overrides.title ?? "title",
    cwd: overrides.cwd ?? "/work",
    updated_at: overrides.updated_at ?? "2026-09-06T00:00:00.000Z",
    rollout_path: overrides.rollout_path ?? "/rollout.jsonl",
    rollout_exists: overrides.rollout_exists ?? true,
    live: overrides.live ?? false,
    pid: overrides.pid ?? null,
  };
}

describe("registry discovery and listing", () => {
  test("lists the configured CODEX_HOME without reading the default profile", () => {
    const defaultParent = makeHome();
    const defaultHome = join(defaultParent, ".codex");
    mkdirSync(defaultHome);
    const configuredHome = makeHome();
    const row: Row = {
      id: "configured-profile", rollout_path: "/fixture.jsonl", updated_at: 1,
      cwd: "/work", title: "configured", name: null, archived: 0, recency_at_ms: 1,
    };
    createState(defaultHome, 5, [{ ...row, id: "wrong-default-profile" }]);
    createState(configuredHome, 5, [row]);
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { listSessions } from ${JSON.stringify(`${import.meta.dir}/registry.ts`)};
      console.log(JSON.stringify(listSessions().map((entry) => entry.id)));
    `], {
      env: { ...process.env, HOME: defaultParent, CODEX_HOME: configuredHome },
      stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe('["configured-profile"]\n');
  });

  test("reads a WAL-mode registry whose -wal and -shm sidecars are absent", () => {
    // Codex deletes both sidecars whenever its last connection closes; a plain
    // read-only open of that idle state fails with SQLITE_CANTOPEN.
    const home = makeHome();
    createState(home, 5, [
      {
        id: "33333333-1111-4111-8111-111111111111",
        rollout_path: "/rollout.jsonl",
        updated_at: 1788747755,
        cwd: "/work",
        title: "idle registry",
        name: "example planning",
        archived: 0,
        recency_at_ms: 0,
      },
    ], "wal");
    // Bun keeps the sidecars after close; Codex's last connection removes them.
    Bun.spawnSync(["trash", join(home, "state_5.sqlite-wal"), join(home, "state_5.sqlite-shm")]);
    expect(existsSync(join(home, "state_5.sqlite-wal"))).toBe(false);
    expect(existsSync(join(home, "state_5.sqlite-shm"))).toBe(false);
    expect(readFileSync(join(home, "state_5.sqlite")).subarray(18, 20)).toEqual(Buffer.from([2, 2]));

    const sessions = listSessions({ codexHome: home });

    expect(sessions.map((entry) => [entry.id, entry.name])).toEqual([
      ["33333333-1111-4111-8111-111111111111", "example planning"],
    ]);
    expect(existsSync(join(home, "state_5.sqlite-wal"))).toBe(false);
    expect(existsSync(join(home, "state_5.sqlite-shm"))).toBe(false);
  });

  test("uses only the highest numeric state_N sqlite registry", () => {
    const home = makeHome();
    writeFileSync(join(home, "session_index.jsonl"), '{"id":"fallback","thread_name":"fallback","updated_at":"2026-01-01T00:00:00Z"}\n');
    createState(home, 2, [
      {
        id: "from-state-2",
        rollout_path: "/old.jsonl",
        updated_at: 1_600_000_000,
        cwd: "/old",
        title: "old",
        name: null,
        archived: 0,
        recency_at_ms: 1_600_000_000_000,
      },
    ]);
    createState(home, 10, [
      {
        id: "from-state-10",
        rollout_path: "/new.jsonl",
        updated_at: 1_700_000_000,
        cwd: "/new",
        title: "new",
        name: "new-name",
        archived: 0,
        recency_at_ms: 1_700_000_000_000,
      },
    ]);

    expect(listSessions({ codexHome: home })).toEqual([
      {
        id: "from-state-10",
        name: "new-name",
        title: "new",
        cwd: "/new",
        updated_at: "2023-11-14T22:13:20.000Z",
        rollout_path: "/new.jsonl",
        rollout_exists: false,
        live: false,
        pid: null,
      },
    ]);
  });

  test("falls back to the JSONL index only when no sqlite registry exists", () => {
    const home = makeHome();
    const sessionsDirectory = join(home, "sessions", "2026", "09", "06");
    mkdirSync(sessionsDirectory, { recursive: true });
    const rollout = join(sessionsDirectory, "rollout-2026-09-06-thread-new.jsonl");
    writeFileSync(rollout, '{"type":"session_meta"}\n');
    writeFileSync(
      join(home, "session_index.jsonl"),
      [
        '{"id":"thread-old","thread_name":"old name","updated_at":"2026-09-05T10:00:00.000Z"}',
        '{"id":"thread-new","thread_name":"first name","updated_at":"2026-09-06T10:00:00.000Z"}',
        '{"id":"thread-new","thread_name":"latest name","updated_at":"2026-09-06T11:00:00.000Z"}',
        "",
      ].join("\n"),
    );

    expect(listSessions({ codexHome: home })).toEqual([
      {
        id: "thread-new",
        name: "latest name",
        title: "latest name",
        cwd: "",
        updated_at: "2026-09-06T11:00:00.000Z",
        rollout_path: rollout,
        rollout_exists: true,
        live: false,
        pid: null,
      },
      {
        id: "thread-old",
        name: "old name",
        title: "old name",
        cwd: "",
        updated_at: "2026-09-05T10:00:00.000Z",
        rollout_path: "",
        rollout_exists: false,
        live: false,
        pid: null,
      },
    ]);
  });

  test("filters archived rows before limiting and truncates titles to 80 characters", () => {
    const home = makeHome();
    createState(home, 5, [
      {
        id: "archived-newest",
        rollout_path: "/archived.jsonl",
        updated_at: 1_800_000_000,
        cwd: "/archived",
        title: "archived",
        name: null,
        archived: 1,
        recency_at_ms: 1_800_000_000_000,
      },
      {
        id: "active-middle",
        rollout_path: "/active.jsonl",
        updated_at: 1_700_000_000,
        cwd: "/active",
        title: "123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890",
        name: null,
        archived: 0,
        recency_at_ms: 1_700_000_000_000,
      },
      {
        id: "active-oldest",
        rollout_path: "/older.jsonl",
        updated_at: 1_600_000_000,
        cwd: "/older",
        title: "older",
        name: null,
        archived: 0,
        recency_at_ms: 1_600_000_000_000,
      },
    ]);

    expect(listSessions({ codexHome: home, includeArchived: false, limit: 1 })[0]?.title).toBe(
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
    );
    expect(listSessions({ codexHome: home, includeArchived: false, limit: 1 })[0]?.id).toBe(
      "active-middle",
    );
    expect(listSessions({ codexHome: home, includeArchived: true, limit: 1 })[0]?.id).toBe(
      "archived-newest",
    );
  });

  test("sorts and reports the documented updated_at rather than the recency marker", () => {
    const home = makeHome();
    createState(home, 5, [
      {
        id: "newer-update",
        rollout_path: "/newer.jsonl",
        updated_at: 1_700_000_000,
        cwd: "/newer",
        title: "newer",
        name: null,
        archived: 0,
        recency_at_ms: 1_600_000_000_000,
      },
      {
        id: "older-update-newer-recency",
        rollout_path: "/older.jsonl",
        updated_at: 1_650_000_000,
        cwd: "/older",
        title: "older",
        name: null,
        archived: 0,
        recency_at_ms: 1_800_000_000_000,
      },
    ]);

    const sessions = listSessions({ codexHome: home });
    expect(sessions.map((item) => item.id)).toEqual([
      "newer-update",
      "older-update-newer-recency",
    ]);
    expect(sessions[0]?.updated_at).toBe("2023-11-14T22:13:20.000Z");
  });

  test("drops a live internal lock that has no registry entry", () => {
    const home = makeHome();
    createState(home, 5, [
      {
        id: "33333333-1111-4111-8111-111111111111",
        rollout_path: "/registered.jsonl",
        updated_at: 1_700_000_000,
        cwd: "/registered",
        title: "registered",
        name: "scratch",
        archived: 0,
        recency_at_ms: 1_700_000_000_000,
      },
    ]);
    const liveThreads = parseLsofOutput(
      [
        "p81025",
        "ccodex",
        "f54",
        "au",
        "n/tmp/33333333-1111-4111-8111-111111111111.lock",
        "f61",
        "au",
        "n/tmp/33333333-2222-4222-8222-222222222222.lock",
      ].join("\n"),
    );

    expect(listSessions({ codexHome: home, liveThreads })).toEqual([
      {
        id: "33333333-1111-4111-8111-111111111111",
        name: "scratch",
        title: "registered",
        cwd: "/registered",
        updated_at: "2023-11-14T22:13:20.000Z",
        rollout_path: "/registered.jsonl",
        rollout_exists: false,
        live: true,
        pid: 81025,
      },
    ]);
  });

  test("applies live_only before the result limit", () => {
    const home = makeHome();
    createState(home, 5, [
      {
        id: "dead-newest",
        rollout_path: "/dead.jsonl",
        updated_at: 1_800_000_000,
        cwd: "/dead",
        title: "dead",
        name: null,
        archived: 0,
        recency_at_ms: 1_800_000_000_000,
      },
      {
        id: "live-older",
        rollout_path: "/live.jsonl",
        updated_at: 1_700_000_000,
        cwd: "/live",
        title: "live",
        name: null,
        archived: 0,
        recency_at_ms: 1_700_000_000_000,
      },
    ]);

    expect(
      listSessions({
        codexHome: home,
        liveThreads: new Map([["live-older", 4242]]),
        liveOnly: true,
        limit: 1,
      }),
    ).toEqual([
      {
        id: "live-older",
        name: null,
        title: "live",
        cwd: "/live",
        updated_at: "2023-11-14T22:13:20.000Z",
        rollout_path: "/live.jsonl",
        rollout_exists: false,
        live: true,
        pid: 4242,
      },
    ]);
  });

  test("applies live_only to the JSONL fallback registry", () => {
    const home = makeHome();
    writeFileSync(
      join(home, "session_index.jsonl"),
      [
        '{"id":"dead-newest","thread_name":"dead","updated_at":"2026-09-06T12:00:00.000Z"}',
        '{"id":"live-older","thread_name":"live","updated_at":"2026-09-06T11:00:00.000Z"}',
        "",
      ].join("\n"),
    );

    expect(
      listSessions({
        codexHome: home,
        liveThreads: new Map([["live-older", 5150]]),
        liveOnly: true,
        limit: 1,
      }),
    ).toEqual([
      {
        id: "live-older",
        name: "live",
        title: "live",
        cwd: "",
        updated_at: "2026-09-06T11:00:00.000Z",
        rollout_path: "",
        rollout_exists: false,
        live: true,
        pid: 5150,
      },
    ]);
  });

  test("live_only equals registry membership in seeded liveness sets", () => {
    const home = makeHome();
    const orderedIds = [
      "thread-07",
      "thread-06",
      "thread-05",
      "thread-04",
      "thread-03",
      "thread-02",
      "thread-01",
      "thread-00",
    ];
    writeFileSync(
      join(home, "session_index.jsonl"),
      orderedIds
        .map((id, index) =>
          JSON.stringify({
            id,
            thread_name: id,
            updated_at: `2026-09-06T${String(19 - index).padStart(2, "0")}:00:00.000Z`,
          })
        )
        .join("\n") + "\n",
    );

    let randomState = 0x5eed1234;
    let mixedCases = 0;
    for (let trial = 0; trial < 64; trial += 1) {
      const liveThreads = new Map<string, number>();
      for (let index = 0; index < orderedIds.length; index += 1) {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        const isLive = index === 0 || (index !== 1 && (randomState & 1) === 1);
        if (isLive) liveThreads.set(orderedIds[index]!, 10_000 + trial * 10 + index);
      }
      if (liveThreads.size > 0 && liveThreads.size < orderedIds.length) mixedCases += 1;

      const expected = orderedIds
        .filter((id) => liveThreads.has(id))
        .map((id) => [id, liveThreads.get(id)!] as const);
      const actual = listSessions({
        codexHome: home,
        liveThreads,
        liveOnly: true,
        limit: orderedIds.length,
      }).map((session) => [session.id, session.pid] as const);
      expect(actual).toEqual(expected);
    }
    expect(mixedCases).toBe(64);
  });
});

describe("session resolution", () => {
  test("exact name wins over a competing UUID prefix", () => {
    const sessions = [
      session({ id: "abc11111-1111-1111-1111-111111111111", name: "other" }),
      session({ id: "fff22222-2222-2222-2222-222222222222", name: "abc" }),
    ];

    expect(resolveSessionFrom(sessions, "abc").id).toBe(
      "fff22222-2222-2222-2222-222222222222",
    );
  });

  test("ambiguous UUID prefix error lists every candidate", () => {
    const sessions = [
      session({ id: "abc11111-1111-1111-1111-111111111111", name: "first" }),
      session({ id: "abc22222-2222-2222-2222-222222222222", name: "second" }),
    ];

    expect(() => resolveSessionFrom(sessions, "abc")).toThrow(
      "Ambiguous Codex session 'abc'. Candidates:\n- abc11111-1111-1111-1111-111111111111 (first)\n- abc22222-2222-2222-2222-222222222222 (second)",
    );
  });
});
