import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLsofOutput, probeLiveThreads } from "./liveness";

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) Bun.spawnSync(["trash", directory]);
});

function directory(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(value);
  return value;
}

function restorePath(prior: string | undefined): void {
  if (prior === undefined) delete process.env.PATH;
  else process.env.PATH = prior;
}

function fakeLsof(root: string, source: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, "lsof");
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);
  return bin;
}

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const thirdId = "33333333-3333-4333-8333-333333333333";
const fourthId = "44444444-4444-4444-8444-444444444444";

describe("Codex writable-descriptor liveness", () => {
  test("maps four Codex writable descriptors across process groups", () => {
    const output = [
      "p53141", "ccodex", "f47", "au", `n/Users/example/.codex/thread-writer-locks/${firstId}.lock`,
      "f59", "aw", `n/Users/example/.codex/thread-writer-locks/${secondId}.lock`,
      "p81025", "ccodex", "f54", "au", `n/Users/example/.codex/thread-writer-locks/${thirdId}.lock`,
      "f61", "au", `n/Users/example/.codex/thread-writer-locks/${fourthId}.lock`, "",
    ].join("\n");
    expect(Array.from(parseLsofOutput(output))).toEqual([
      [firstId, 53141], [secondId, 53141], [thirdId, 81025], [fourthId, 81025],
    ]);
  });

  test("rejects reader-only descriptors, non-Codex processes, and absent evidence", () => {
    const output = [
      "p11", "ccodex", "f1", "ar", `n/tmp/${firstId}.lock`,
      "p12", "cbun", "f1", "au", `n/tmp/${secondId}.lock`,
      "p13", "f1", "au", `n/tmp/${thirdId}.lock`,
      "p14", "ccodex", "f1", `n/tmp/${fourthId}.lock`,
    ].join("\n");
    expect(Array.from(parseLsofOutput(output))).toEqual([]);
  });

  test("does not inherit writable evidence across descriptors or process groups", () => {
    const output = [
      "p21", "ccodex", "f1", "au", `n/tmp/${firstId}.lock`,
      "f2", `n/tmp/${secondId}.lock`,
      "p22", "f1", "au", `n/tmp/${thirdId}.lock`,
      "p23", "ccodex", "f1", "ar", `n/tmp/${fourthId}.lock`,
    ].join("\n");
    expect(Array.from(parseLsofOutput(output))).toEqual([[firstId, 21]]);
  });

  test("rejects malformed process, descriptor, and lock identifiers", () => {
    const output = [
      "pnot-a-pid", "ccodex", "f1", "au", `n/tmp/${firstId}.lock`,
      "p0", "ccodex", "f1", "au", `n/tmp/${secondId}.lock`,
      "p9007199254740992", "ccodex", "f1", "au", `n/tmp/${thirdId}.lock`,
      "p73", "ccodex", "f", "au", `n/tmp/${fourthId}.lock`,
      "f9", "au", "n/tmp/not-a-thread.lock",
      "f10", "au", `n/tmp/${firstId}.lock`,
    ].join("\n");
    expect(Array.from(parseLsofOutput(output))).toEqual([[firstId, 73]]);
  });

  test("rejects orphan, duplicate, and interrupted file-name records", () => {
    const output = [
      "p101", "ccodex", "au", `n/tmp/${firstId}.lock`,
      "f9", "au", `n/tmp/${secondId}.lock`, `n/tmp/${thirdId}.lock`,
      "f10", "au", "", `n/tmp/${fourthId}.lock`,
    ].join("\r\n");
    expect(Array.from(parseLsofOutput(output))).toEqual([]);
  });

  test("parses file fields in either order and ignores unrelated metadata", () => {
    const output = [
      "p101", "ccodex", "f9", `n/tmp/${firstId}.lock`, "l ", "au",
      "f10", "aw", "tREG", `n/tmp/${secondId}.lock`,
    ].join("\r\n");
    expect(Array.from(parseLsofOutput(output))).toEqual([[firstId, 101], [secondId, 101]]);
  });

  test("seeded file-field permutations preserve the independently specified eligible records", () => {
    let seed = 918273;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    let reordered = 0;
    for (let sample = 0; sample < 80; sample += 1) {
      const records = [
        ["p101", "ccodex", "f9", "au", `n/tmp/${firstId}.lock`, "l "],
        ["p202", "cbun", "f3", "au", `n/tmp/${secondId}.lock`, "l "],
        ["p303", "ccodex", "f5", "ar", `n/tmp/${thirdId}.lock`, "l "],
        ["p404", "ccodex", "f7", "aw", `n/tmp/${fourthId}.lock`, "l "],
      ];
      for (const record of records) {
        for (let index = record.length - 1; index > 3; index -= 1) {
          const swap = 3 + random() % (index - 2);
          if (swap !== index) reordered += 1;
          [record[index], record[swap]] = [record[swap]!, record[index]!];
        }
      }
      expect(Array.from(parseLsofOutput(records.flat().join("\n")))).toEqual([[firstId, 101], [fourthId, 404]]);
    }
    expect(reordered).toBeGreaterThan(0);
  });

  test("returns no live threads when the lock directory is absent", async () => {
    expect(Array.from(await probeLiveThreads(join(directory("codex-bridge-liveness-"), "missing")))).toEqual([]);
  });

  test("does not mistake this process's real read-only file descriptor for Codex", async () => {
    const root = directory("codex-bridge-reader-");
    const path = join(root, `${firstId}.lock`);
    writeFileSync(path, "");
    const fd = openSync(path, "r");
    try { expect(Array.from(await probeLiveThreads(root))).toEqual([]); }
    finally { closeSync(fd); }
  });

  test("returns no live threads when lsof exits 1 with no matches", async () => {
    const root = directory("codex-bridge-lsof-empty-");
    writeFileSync(join(root, `${firstId}.lock`), "");
    const bin = fakeLsof(root, "#!/bin/sh\nexit 1\n");
    const prior = process.env.PATH;
    process.env.PATH = bin;
    try { expect(Array.from(await probeLiveThreads(root))).toEqual([]); }
    finally { restorePath(prior); }
  });

  test("probes valid lock files once and requests process and access evidence", async () => {
    const root = directory("codex-bridge-lsof-live-");
    const firstLock = join(root, `${firstId}.lock`);
    const secondLock = join(root, `${secondId}.lock`);
    writeFileSync(firstLock, ""); writeFileSync(secondLock, "");
    writeFileSync(join(root, "other.lock"), "");
    mkdirSync(join(root, `${thirdId}.lock`));
    const invocation = join(root, "invocations");
    const argumentsPath = join(root, "arguments");
    const bin = fakeLsof(root, [
      `#!${process.execPath}`,
      `await Bun.write(${JSON.stringify(invocation)}, 'x');`,
      `await Bun.write(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `console.log(${JSON.stringify(["p9001", "ccodex", "f7", "au", `n${firstLock}`, "f8", "aw", `n${secondLock}`].join("\n"))});`, "",
    ].join("\n"));
    const prior = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(Array.from(await probeLiveThreads(root))).toEqual([[firstId, 9001], [secondId, 9001]]);
      expect(readFileSync(invocation, "utf8")).toBe("x");
      expect(JSON.parse(readFileSync(argumentsPath, "utf8"))).toEqual(["-F", "pcfan", firstLock, secondLock]);
    } finally { restorePath(prior); }
  });

  test("returns no live threads when lsof is not installed", async () => {
    const root = directory("codex-bridge-lsof-missing-");
    writeFileSync(join(root, `${secondId}.lock`), "");
    const prior = process.env.PATH;
    process.env.PATH = root;
    try { expect(Array.from(await probeLiveThreads(root))).toEqual([]); }
    finally { restorePath(prior); }
  });

  test("kills a stalled lsof child and returns a bounded timeout error", async () => {
    const root = directory("codex-bridge-lsof-timeout-");
    writeFileSync(join(root, `${firstId}.lock`), "");
    const bin = fakeLsof(root, [
      `#!${process.execPath}`,
      "setInterval(() => {}, 10);",
      "setTimeout(() => process.exit(0), 2_000);", "",
    ].join("\n"));
    // Capture the OS pid at spawn, since the deadline may precede script startup.
    const spawn = Bun.spawn;
    let childPid = 0;
    const monitor = spyOn(Bun, "spawn").mockImplementation(((...arguments_: unknown[]) => {
      const child = Reflect.apply(spawn, Bun, arguments_) as ReturnType<typeof Bun.spawn>;
      childPid = child.pid;
      return child;
    }) as typeof Bun.spawn);
    const prior = process.env.PATH;
    process.env.PATH = bin;
    try {
      const startedAt = Date.now();
      await expect(probeLiveThreads(root, { timeoutMs: 150 })).rejects.toThrow("lsof timed out after 150 ms");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(childPid).toBeGreaterThan(0);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally { monitor.mockRestore(); restorePath(prior); }
  });

  test("a wrapper's exited parent cannot leave a child holding the result pipes open", async () => {
    const root = directory("codex-bridge-lsof-descendant-");
    writeFileSync(join(root, `${firstId}.lock`), "");
    const pidPath = join(root, "descendant-pid");
    const bin = fakeLsof(root, [
      "#!/bin/sh", "/bin/sleep 30 &",
      `printf '%s' "$!" > '${pidPath}'`, "exit 0", "",
    ].join("\n"));
    const prior = process.env.PATH;
    process.env.PATH = bin;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const waiting = probeLiveThreads(root, { timeoutMs: 800 }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    try {
      const outcome = await Promise.race([
        waiting,
        new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve("deadline missed"), 1_500); }),
      ]);
      expect(outcome).toBe("lsof timed out after 800 ms");
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      clearTimeout(watchdog);
      restorePath(prior);
      try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch { /* Already reaped. */ }
      await waiting;
    }
  });
});
