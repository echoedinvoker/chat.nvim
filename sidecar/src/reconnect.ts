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
