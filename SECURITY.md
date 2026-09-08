# Security

## Scope

The current release supports a local, trusted MCP client on macOS. The plugin can read session metadata and conversation text from the selected Codex home and send prompts to existing sessions. It is not a sandbox, an access-control boundary between projects, or a secret-redaction service.

Only the latest release receives fixes. The bridge's upstream SDK is pinned in `bun.lock`; dependency updates should run the test suite and MCP handshake before release.

## Reporting

Do not put tokens, real transcripts, private paths, or client details in public issues. Use GitHub's **Security → Report a vulnerability** if private reporting is available. If it is unavailable, open a content-free issue asking the maintainer to enable a private reporting channel before sharing details. No response-time commitment is offered.

For ordinary bugs, provide the Codex, Claude Code, Bun, and macOS versions plus a synthetic reproduction. Treat session titles, paths, and identifiers as potentially identifying information.
