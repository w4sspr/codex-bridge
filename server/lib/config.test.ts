import { describe, expect, test } from "bun:test";
import { codexHomeFromSystem } from "./config";

describe("Codex home configuration", () => {
  test("uses the configured profile and observes changes between calls", () => {
    const prior = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/profiles/first";
      expect(codexHomeFromSystem()).toBe("/profiles/first");
      process.env.CODEX_HOME = "/profiles/second";
      expect(codexHomeFromSystem()).toBe("/profiles/second");
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prior;
    }
  });

  test("resolves a relative profile against the current working directory", () => {
    const prior = process.env.CODEX_HOME;
    const priorCwd = process.cwd();
    try {
      process.chdir("/");
      process.env.CODEX_HOME = "profiles/../profiles/example";
      expect(codexHomeFromSystem()).toBe("/profiles/example");
    } finally {
      process.chdir(priorCwd);
      if (prior === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prior;
    }
  });

  test("empty and absent overrides both use the user's default profile", () => {
    // Bun caches homedir(), so HOME must be set before the child imports node:os.
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { codexHomeFromSystem } from ${JSON.stringify(`${import.meta.dir}/config.ts`)};
      process.env.CODEX_HOME = "";
      console.log(codexHomeFromSystem());
      delete process.env.CODEX_HOME;
      console.log(codexHomeFromSystem());
    `], { env: { ...process.env, HOME: "/Users/example" }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("/Users/example/.codex\n/Users/example/.codex\n");
  });
});
