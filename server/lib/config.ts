import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Use the same profile for registry reads, process discovery, and queued messages. */
export function codexHomeFromSystem(): string {
  const configured = process.env.CODEX_HOME;
  return configured ? resolve(configured) : join(homedir(), ".codex");
}
