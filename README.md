# codex-bridge

Ask a running Codex CLI session for a second opinion from Claude Code, then continue the conversation without copying messages between terminals.

`codex-bridge` is a Claude Code plugin with four MCP tools: discover sessions, send a message, wait for a reply, and read recent conversation text. It uses the Codex session you already opened, with that session's context and permissions.

```text
Claude Code ── MCP over stdio ── codex-bridge ── codex queue ── Codex CLI
                                    ↑                          │
                                    └── reads registry/rollout ─┘
```

This is an independent community project, unaffiliated with OpenAI or Anthropic. It is an early release built against Codex CLI 0.153.4 on macOS. Codex's local session format is not a stable integration API, so compatibility with other versions must be checked.

## Requirements

- **macOS**, with `lsof` available. Other operating systems are not currently tested.
- **Bun 1.3.14 or later**, available on the PATH used by Claude Code.
- **Codex CLI with `codex queue`**, already configured and signed in. Tested: 0.153.4.
- **Claude Code with plugin support.** Tested: 2.1.265.

Check the commands before installing:

```sh
bun --version
codex --version
codex queue --help
claude --version
```

## Install

In Claude Code:

```text
/plugin marketplace add w4sspr/codex-bridge
/plugin install codex-bridge@codex-bridge
/reload-plugins
```

Claude Code copies the plugin into its cache and installs its locked dependencies with Bun. See [Claude Code's dependency-install behavior](https://code.claude.com/docs/en/plugins-reference#nodejs-package-dependencies). Restart Claude Code if the MCP server does not appear.

To try a local checkout before publishing, substitute its absolute path for `w4sspr/codex-bridge` in the marketplace command. For development without installing a marketplace:

```sh
git clone https://github.com/w4sspr/codex-bridge.git
cd codex-bridge
bun install --frozen-lockfile --ignore-scripts
claude --plugin-dir "$PWD"
```

No separate API key belongs in this repository. Codex uses its existing authentication. Queueing a prompt may consume the target session's normal model usage.

## First conversation

1. Open `codex` in another terminal and send its first message. A blank session has no persisted rollout to target.
2. In Claude Code, ask it to list live Codex sessions. Use a full session UUID, a unique UUID prefix, or an exact session name.
3. Start a discussion:

```text
/codex-bridge:talk 11111111 Review the retry strategy we just discussed.
```

Replace the example prefix with your target. The command sends one message at a time and stops when the agents agree or after four rounds. Agreement is a second opinion, not a guarantee of correctness.

For session names containing spaces, use the UUID or a unique UUID prefix with `/talk`. Direct MCP calls accept the full name.

## MCP tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `codex_list_sessions` | `limit=20`, `include_archived=false`, `live_only=false` | Lists persisted sessions, newest first, with liveness and PID. |
| `codex_send` | `thread`, `message`, `wait=true`, `timeout_s=300`, `force=false` | Queues a uniquely marked message and optionally waits for its matching turn. Returns `queued_id` and `request_id`. |
| `codex_wait_reply` | `thread`, optional `request_id`, `timeout_s=300` | With `request_id`, recovers that request's full reply, including replies completed before this call. Without it, waits for the next completion from the current transcript end. |
| `codex_read_transcript` | `thread`, `last_n=10` | Reads recent user and assistant messages, including assistant commentary. Does not require a running session. |

A reply has `status` (`replied`, `aborted`, or `timeout`), `reply`, `elapsed_ms`, and `tool_calls_seen`. A send with `wait: false` returns `status: "queued"`.

### Recover a slow reply

Keep the `request_id` returned by `codex_send`. After a timeout, or a send with `wait: false`, use it with the same thread:

```json
{
  "thread": "11111111-1111-4111-8111-111111111111",
  "request_id": "22222222-2222-4222-8222-222222222222",
  "timeout_s": 300
}
```

Pass that object to `codex_wait_reply`, replacing both example IDs. It searches the persisted rollout, so recovery also works after the bridge restarts or the target session closes. A recovered reply includes the whole matched turn, including text returned in earlier partial replies.

Do not resend a timed-out message automatically. Queue delivery may already have happened. An aborted turn is not an agreement. Without `request_id`, `codex_wait_reply` can observe an unrelated turn and cannot recover a reply that already finished.

## Privacy and permissions

- This is a local stdio server. It does not open a network listener or add telemetry. `codex queue` can cause the target Codex session to contact its configured model provider and execute tools under its existing permissions.
- The bridge opens the registry read-only and reads rollout files. It invokes the supported `codex queue` command to send messages; it does not directly edit Codex's session files.
- The MCP client can access **all sessions in the selected Codex home**, across projects. Listings include titles, working directories, and rollout paths. Transcript reads can contain private conversation text. Only enable the plugin in a client you trust with that data.
- There is no secret detector or redaction filter on messages or transcripts. Review what you ask the agents to share. Do not include credentials or confidential client data in public bug reports.
- `CODEX_HOME` selects an alternate session store. If unset or empty, the bridge uses `~/.codex`. The server and target Codex process must use the same home. Remote app-server sessions are not supported.

## Limits and troubleshooting

- **No live sessions:** ensure Codex has received its first message and `lsof` is available. Liveness is a heuristic: a process named `codex` must have the session's lock file open for writing. It is not a guarantee that the session will remain running or answer.
- **Stopped session:** sends are rejected unless `force: true`. Force queues a message for later delivery and does not start Codex. The consensus command never uses it.
- **Busy session:** Codex delivers queued messages at a turn boundary. Use the returned `request_id` to recover a delayed answer.
- **MCP request timed out:** client timeouts are separate from `timeout_s`. Configure the client deadline above the bridge wait, or use `wait: false` and recover by `request_id`.
- **Missing dependencies:** current Claude Code installs them into each cached plugin version. If installation was interrupted or used an older Claude Code, inspect `/plugin` for the installed directory, then run `bun install --frozen-lockfile --ignore-scripts` there and reload.
- **Malformed rollout or missing completion:** the bridge reports an error when recognized records lose required structure, or when a later user turn would cause it to misattribute a reply. Unknown record types are ignored. Include a synthetic reproduction when reporting format changes.
- **Large histories:** registry lookup and transcript polling use local files; polling rereads the rollout. Very large sessions may be slow.

Update with `/plugin marketplace update codex-bridge`, followed by `/plugin update codex-bridge@codex-bridge` and `/reload-plugins` (or restart).

If migrating from the old local marketplace, uninstall `codex-bridge@codex-bridge-local` before installing this one to avoid duplicate tools.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
timeout 120 bun test
timeout 20 bun run verify:mcp
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
```

The tests use synthetic registries and transcripts; they do not require model credentials. On macOS, test cleanup uses `trash`. Install `coreutils` and `trash` with Homebrew if those commands are missing. The bare server waits silently for MCP JSON-RPC on stdin.

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/ARCHITECTURE.md), and [SECURITY.md](SECURITY.md). Licensed under [MIT](LICENSE).
