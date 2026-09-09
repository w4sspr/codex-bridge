# MCP tool reference

[Back to the README](../README.md)


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
