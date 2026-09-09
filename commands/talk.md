---
description: Discuss a topic with a live Codex CLI session and seek consensus
argument-hint: '<session> <topic>'
allowed-tools: mcp__plugin_codex-bridge_codex-bridge__codex_list_sessions, mcp__plugin_codex-bridge_codex-bridge__codex_send, mcp__plugin_codex-bridge_codex-bridge__codex_wait_reply, mcp__plugin_codex-bridge_codex-bridge__codex_read_transcript
---

Use the `codex-bridge` skill to run its consensus loop.

Interpret the first value in `$ARGUMENTS` as the Codex session target and the remainder as the topic. If either is missing, ask the user for it before sending a message. Confirm the target when it is ambiguous.

List with `live_only: true` and only start the loop for a result with `live: true` and a non-null `pid`. If the requested session is not in that result, list all sessions and explain whether it exists but has no running Codex process. Do not use `force: true` for this command.

Do not add the bridge prefix yourself. Use the round limit requested by the user, or default to 4 rounds if none is specified. One round is one outgoing Claude message and its matching Codex reply. Send one message per round and keep its `request_id`. Recover timeouts with `codex_wait_reply` using that ID and thread. Stop if the request remains pending, the agents agree, the discussion stops making progress, or the requested round limit is reached. Finish with agreed points and any residual disagreement.
