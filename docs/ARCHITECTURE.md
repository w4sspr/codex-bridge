# Architecture

The plugin registers one stdio MCP server, `server/index.ts`. No HTTP server runs.

- **Registry:** `server/lib/registry.ts` reads the highest numeric `state_N.sqlite` database read-only. If none exists, it falls back to `session_index.jsonl`. SQLite errors are surfaced instead of silently selecting stale data. An idle WAL database without sidecars has a guarded immutable-read fallback.
- **Liveness:** `server/lib/liveness.ts` inspects session lock descriptors with one `lsof` invocation. A Codex process with a writable descriptor is evidence of a likely active session; another process opening a stale lock is insufficient. The result is a point-in-time heuristic.
- **Sending:** `server/lib/queue.ts` executes `codex queue` using an argv array. Each send includes a random request marker. Shell metacharacters in message text remain arguments, not commands.
- **Replies:** `server/lib/rollout.ts` reads complete JSONL lines, matches the request marker, gathers assistant text and tool counts, and stops at completion or abort. A subsequent user turn without the expected completion is an error. Recovery uses the persisted marker rather than volatile server memory.
- **Configuration:** the registry, locks, and queue child share the resolved `CODEX_HOME` (default `~/.codex`).

A queued message ID identifies Codex's queue acknowledgement; the separate request ID identifies the bridge envelope persisted in the rollout. Neither is a security credential. A queue error or killed subprocess does not prove the message was never delivered, so callers must not blindly retry sends.

The server reads local metadata and conversation text across the selected home. It relies on the target Codex session's permissions for any work triggered by queued prompts. The skill's advice about sensitive information is guidance, not an enforced filter.

## Fixtures

All checked-in transcripts and identifiers are synthetic. Fixtures cover the observed record shapes without retaining personal session text, message identifiers, or paths. Unknown record kinds are ignored; malformed recognized records fail explicitly.

## Compatibility checks

The queue CLI command is the supported send primitive. Registry schemas, lock filenames, and rollout records are implementation details. Check the CLI's help, validate synthetic fixtures, and try an explicitly chosen disposable live session before claiming support for a new Codex version. Do not use a real conversation as a CI fixture.
