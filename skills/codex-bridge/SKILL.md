---
name: codex-bridge
description: Reach consensus with a live Codex CLI session through the codex-bridge MCP tools
user-invocable: true
argument-hint: '<session> <topic>'
---

# Codex Bridge Consensus Loop

Use this skill when the user wants Claude and an already-running Codex TUI session to discuss a question and reach consensus.

## Protocol

1. Call `codex_list_sessions` with `live_only: true`. Resolve the requested target by full UUID, unique UUID prefix, or exact name. If it is absent, list all sessions to distinguish a stopped session from an unknown target. If the request is ambiguous, show the candidates and ask the user to choose before sending anything.
2. Put Claude's current position and the specific question for Codex in one concise message. Do not add `[claude-code bridge]`; the server adds that marker.
3. Call `codex_send` once with `wait: true`. Use the default 300-second timeout unless the user requests another duration. Keep the returned `request_id` with its thread.
4. If Codex disagrees, send one follow-up naming the specific point of disagreement. Do not restate the whole discussion.
5. Never send a second message while the preceding request is unresolved. After a timeout, call `codex_wait_reply` with the same thread and the returned `request_id`; this also recovers a reply completed between calls. If the queue command errors after starting, use the request ID in its error when available. Delivery may already have happened, so never automatically resend. If recovery keeps timing out, stop the discussion and report the pending request instead of starting another round. Do not use the uncorrelated wait mode to recover a send.
6. Use the user's requested round limit as `max_rounds`, defaulting to 4 if none is specified. One round is one Claude message and its matching Codex reply. Stop when both agents agree, the round limit is reached, or the discussion repeats positions without new evidence or actionable points. Report any remaining disagreement rather than forcing consensus.
7. Report the agreed points and open points to the user. Mention that the full exchange is available through `codex_read_transcript`.

## Safety

- Never send secrets, credentials, private keys, tokens, or sensitive user data. The server does not redact content; this rule depends on the caller.
- Do not infer a target when multiple sessions match.
- A session must have received its first user message in the Codex window before it can be reached.
- Only target a session whose listing has `live: true` and a non-null `pid`. A stale lock file is not proof that Codex is running.
- Do not set `force: true` during the consensus loop. It deliberately queues to a stopped session and cannot produce a reply until that session runs again.
- Treat an aborted turn as no reply. Surface the abort to the user or ask whether to try a new round.
