# Troubleshooting and updates

[Back to the README](../README.md)


- **No live sessions:** ensure Codex has received its first message and `lsof` is available. Liveness is a heuristic: a process named `codex` must have the session's lock file open for writing. It is not a guarantee that the session will remain running or answer.
- **Stopped session:** sends are rejected unless `force: true`. Force queues a message for later delivery and does not start Codex. The consensus command never uses it.
- **Busy session:** Codex delivers queued messages at a turn boundary. Use the returned `request_id` to recover a delayed answer.
- **MCP request timed out:** client timeouts are separate from `timeout_s`. Configure the client deadline above the bridge wait, or use `wait: false` and recover by `request_id`.
- **Missing dependencies:** current Claude Code installs them into each cached plugin version. If installation was interrupted or used an older Claude Code, inspect `/plugin` for the installed directory, then run `bun install --frozen-lockfile --ignore-scripts` there and reload.
- **Malformed rollout or missing completion:** the bridge reports an error when recognized records lose required structure, or when a later user turn would cause it to misattribute a reply. Unknown record types are ignored. Include a synthetic reproduction when reporting format changes.
- **Large histories:** registry lookup and transcript polling use local files; polling rereads the rollout. Very large sessions may be slow.

Update with `/plugin marketplace update codex-bridge`, followed by `/plugin update codex-bridge@codex-bridge` and `/reload-plugins` (or restart).

If migrating from the old local marketplace, uninstall `codex-bridge@codex-bridge-local` before installing this one to avoid duplicate tools.
