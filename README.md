# codex-bridge

**Connect Claude Code to a running OpenAI Codex CLI session.**

`codex-bridge` is a Claude Code plugin and MCP server for agent to agent messaging. Let Claude and Codex discuss a problem and work towards a consensus.

It connects to the Codex session you already have open, with that session's existing context. You don't need to be a meat proxy copying prompts and answers between terminals.

```text
Claude Code → MCP server → codex queue → your running Codex session
Claude Code ← MCP reply  ← transcript ← Codex's answer
```

## Why I use it

I mostly use this to get Claude and Codex to "sort it out" and reach a consensus. If they disagree about an approach, they can discuss the specific points with each other instead of waiting for me to pass every message along.

That could mean settling on an implementation plan or working through a bug. It also works for code review: Codex can inspect Claude's changes, and Claude can respond to the objections.

Each agent keeps its own conversation history. Claude includes the context Codex needs with each question, and Codex's side of the exchange stays visible in its terminal.

## Requirements

| Requirement | Version / notes |
| --- | --- |
| macOS | Requires `lsof`; other platforms haven't been tested. |
| Bun | 1.3.14 or later, available on Claude Code's PATH. |
| OpenAI Codex CLI | Tested with 0.153.4. Must support `codex queue` and already be configured and signed in. |
| Claude Code | Tested with 2.1.265, with plugin support. |

This is an early release. Other Codex versions haven't been checked, and its internal session format can change between releases. Run `codex queue --help` to check that your CLI has the required command.

## Install in Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add w4sspr/codex-bridge
/plugin install codex-bridge@codex-bridge
/reload-plugins
```

Claude Code copies the plugin into its cache and installs the locked dependencies with Bun. Restart Claude Code if the MCP server doesn't appear. See [Claude Code's dependency-install behavior](https://code.claude.com/docs/en/plugins-reference#nodejs-package-dependencies) for details.

The bridge uses your existing Codex authentication. It needs no extra API key, and messages count towards the target session's normal model usage.

## Start a conversation

### 1. Open Codex

In another terminal, start Codex in the project you want to discuss:

```sh
codex
```

Send at least one message there. The bridge can only find the session after Codex saves its first message.

### 2. Find the session

Back in Claude Code, ask:

```text
Use codex-bridge to list my running Codex sessions.
```

Pick a session from the list. You can use its full UUID, a unique UUID prefix, or its exact name. Or just let Claude figure it out tbh. If more than one session fits, it'll probably ask.

### 3. Ask Codex something

Replace `a1b2c3d4` with your session's UUID prefix:

```text
/codex-bridge:talk a1b2c3d4 Review the current changes for unsafe retries and duplicate writes.
```

Claude sends its position and question to Codex, reads the reply, and follows up on disagreements. When the discussion ends, Claude reports what they agreed on and what remains unresolved.

The default is **four rounds**, with one Claude message and one Codex reply per round. Ask for a different limit in your request, such as "use up to eight rounds." The command stops earlier if the agents agree or start repeating themselves without making progress. You'll still need to judge the result, even when they agree.

This limit is part of `/talk`'s instructions. The MCP tools themselves have no round limit.

If your session name contains spaces, use its UUID or a unique UUID prefix with `/talk`. Direct MCP calls accept the full name.

## Use the MCP tools directly

You can also call the tools individually for your own multi-agent coding workflow:

| Tool | What it does |
| --- | --- |
| `codex_list_sessions` | Lists saved Codex sessions and checks which appear to be running. |
| `codex_send` | Sends a message to a chosen session and optionally waits for the reply. |
| `codex_wait_reply` | Recovers a specific request's reply, including after a timeout or bridge restart. |
| `codex_read_transcript` | Reads recent user and assistant messages from a session. |

Keep the `request_id` returned by a send. If the answer takes too long, pass that ID and the same thread to `codex_wait_reply`. The message may already have been delivered, so resending it could start the same work twice.

The [MCP tool reference](docs/MCP.md) has the arguments, defaults, response fields, and recovery examples.

## Privacy and permissions

The bridge runs locally over stdio. It has no network listener or added telemetry. It reads Codex's registry and transcript files and sends messages through `codex queue`.

**The MCP client can read sessions across projects in the selected Codex home.** That includes session titles, paths, and conversation text. Only enable it in a client you trust with that information. The bridge doesn't redact messages or transcripts.

Codex can contact its model provider and run tools in response to a queued prompt, using the target session's existing permissions. Check what you're asking the agents to share or do.

Both the bridge and Codex must use the same `CODEX_HOME`, which defaults to `~/.codex`. Remote Codex app-server sessions aren't supported.

## Troubleshooting

If no sessions appear, send a first message in Codex and check that both processes use the same `CODEX_HOME`. For a session that appears stopped, check its Codex terminal is still open and `lsof` is available. The liveness check is a heuristic, so a session listed as running isn't guaranteed to answer.

Codex may be finishing another turn when you send a message. Recover a slow reply with its `request_id`. Your MCP client's timeout is separate from the bridge's wait timeout.

See [troubleshooting and updates](docs/TROUBLESHOOTING.md) for dependency problems, format errors, timeout settings, and migration from the old local marketplace.

## Development

Tests use synthetic registries and transcripts; they don't need model credentials. On macOS, install `coreutils` and `trash` with Homebrew if `timeout` or `trash` is missing.

```sh
git clone https://github.com/w4sspr/codex-bridge.git
cd codex-bridge
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
timeout 120 bun test
timeout 20 bun run verify:mcp
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
```

To load your checkout directly:

```sh
claude --plugin-dir "$PWD"
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/ARCHITECTURE.md), and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). An independent community project, unaffiliated with OpenAI or Anthropic (but I'm open to offers).
