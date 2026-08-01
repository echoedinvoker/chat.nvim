const SESSION_GONE_MESSAGE = "Session not found";

/** How many times recoverSession() retries before it gives up and tells the user. */
export const MAX_RECONNECT_ATTEMPTS = 6;

/**
 * A pure function so the retry schedule can be asserted instead of waited out (F49: a stub that
 * answers instantly is the one thing the real path never does).
 *
 * The first attempt is free: by Phase 0.2 Q3 the trigger is the first poll *after* the daemon is
 * back, so in practice that first try is the one that succeeds.
 */
export function backoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(30_000, 1_000 * 2 ** (attempt - 2));
}

/**
 * Two different layers can report a vanished MCP session, and they disagree on the code:
 * chatmux core answers -32000 (src/core/mcp/server.ts:92) while the MCP SDK answers -32001
 * (webStandardStreamableHttp.js:604). Both count. The bare-Error case is what
 * McpClient.rawRequest throws today, before it started carrying the code along.
 *
 * The comparison is exact on purpose: "Chat not found" is an ordinary application error and
 * must never tear down a working session.
 */
export function isSessionGone(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;

  const { code, message } = err as { code?: unknown; message?: unknown };
  if (message !== SESSION_GONE_MESSAGE) return false;

  if (err instanceof Error) return true;
  return code === -32000 || code === -32001;
}

/**
 * Bun's own name for "there was nothing listening on that unix socket", measured 2026-08-01
 * against a socket path that does not exist. ECONNREFUSED/ENOENT are the same outage arriving
 * through node-compatible paths.
 */
const UNREACHABLE_CODES = new Set(["FailedToOpenSocket", "ECONNREFUSED", "ENOENT"]);

/**
 * The other half of the outage pair. A vanished *session* means the daemon is alive and the
 * first retry wins; a daemon that cannot be *reached* can stay gone until someone starts it.
 * Telling them apart is the whole of F60 — collapsing them would make "reconnecting" mean
 * nothing to the person reading the status line.
 *
 * Matching on `code` and not on `message` is deliberate: Bun's message ("Was there a typo in
 * the url or port?") is user-facing prose and will be reworded. It is asserted in the tests so
 * a reword fails loudly there instead of silently switching this detector off.
 *
 * Mutual exclusivity with isSessionGone is carried by the types themselves: these codes are
 * strings, that one compares numbers (-32000/-32001) after an exact message match.
 */
export function isDaemonUnreachable(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;

  const { code } = err as { code?: unknown };
  return typeof code === "string" && UNREACHABLE_CODES.has(code);
}
