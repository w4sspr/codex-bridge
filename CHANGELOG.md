# Changelog

## 0.3.0

First public release candidate.

- Discover persisted Codex CLI sessions and identify likely running sessions.
- Send uniquely marked messages and recover matching replies by request ID across timeouts and bridge restarts.
- Read recent user and assistant transcript messages.
- Honor `CODEX_HOME` consistently and bound child-process waits.
- Include a four-round Claude Code discussion command, synthetic regression fixtures, CI, and an MIT license.

This release is tested against Codex CLI 0.153.4, Claude Code 2.1.265, and Bun 1.3.14 on macOS. The internal registry and rollout formats may change in future Codex releases.
