/**
 * How the SSE stream's reopen schedule is decided. Kept as a pure function so the timing
 * can be asserted directly instead of waited on (F49).
 */

/**
 * Consecutive reopen failures before the degradation becomes visible to the user. Three
 * failures is ~3 seconds (0 + 1s + 2s) of not getting a stream up: past the point where
 * this could still be one flaky attempt. Any success resets the count — this is a
 * threshold, not a decaying score.
 */
export const SSE_DEGRADED_AFTER = 3;

/**
 * The 15s cap is an invariant, not a tuned number: **an SSE reopen must never be slower
 * than the safety poll it sits on top of.** The poll delivers every `CHATMUX_POLL_MS`
 * (15s default) and is what makes delivery correct; the stream is only a latency hint. A
 * backoff longer than the poll interval would mean the "fast path" recovers later than the
 * floor, which makes the low-latency path actively worse than not having it. That is why
 * this does not reuse `backoffMs()` (reconnect.ts) and its 30s cap — that cap belongs to
 * session rebuilding, which has no such floor underneath it.
 *
 * Failure count 0 (i.e. the first reopen after a stream that just ended) is deliberately
 * immediate: a clean stream end is the normal case and must not cost a second of latency.
 */
export function sseReopenDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(15_000, 1_000 * 2 ** (consecutiveFailures - 1));
}
