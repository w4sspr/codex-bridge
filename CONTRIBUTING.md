# Contributing

Small, focused fixes with a reproducible case are welcome. For behavior changes:

1. State the invariant being fixed and add an adversarial regression test that fails before the change.
2. Use synthetic sessions, invented identifiers, and example paths. Never copy real rollout files or client conversations into fixtures.
3. Use Bun and keep dependencies exactly pinned. Run `bun install --frozen-lockfile --ignore-scripts`, `bun run typecheck`, `timeout 120 bun test`, and `timeout 20 bun run verify:mcp`.
4. For parsing or concurrency changes, try counterexamples and record which intentional mutations your tests catch. Do not weaken assertions to reach green.
5. Validate both manifests with `claude plugin validate .` and `claude plugin validate .claude-plugin/plugin.json`.

Tests currently target macOS and use `trash` for temporary-file cleanup. Install `coreutils` and `trash` with Homebrew if missing. Put each test run under a process deadline.

Keep package and plugin versions consistent. `server/index.ts` reads its advertised version from `package.json`. Do not add real API keys or contact live sessions in automated tests.

GitHub Actions runs typechecking, tests, the stdio handshake, dependency auditing, and Gitleaks. Before a release, also install from a clean checkout in a disposable `CLAUDE_CONFIG_DIR` and verify its cached MCP server. Bump all three manifest versions together when changing the published plugin.
