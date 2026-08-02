/**
 * Wait for something to become true, with a deadline — as opposed to sleeping a guessed
 * amount and reading once (F61).
 *
 * The integration test used to `await Bun.sleep(500)` and then look. A fixed sleep cannot
 * tell "not yet" from "never": when a real Telegram round trip took longer than the guess —
 * routine right after the daemon restarts, while the adapter is still backfilling — the
 * test failed for a reason that had nothing to do with the code under test. A test that
 * fails on timing is one people learn to ignore, and a test people ignore will absorb a
 * real failure one day.
 *
 * So: poll until the deadline, and when it does run out, say what was being waited for.
 * "Timed out after 25000ms" tells the next reader nothing.
 */
export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;

  // Probed before the first sleep, not after: if it is already true, waiting is pure delay.
  for (;;) {
    const got = await probe();
    if (got !== undefined) return got;
    if (Date.now() >= deadline) break;
    await Bun.sleep(opts.intervalMs);
  }

  throw new Error(`timed out after ${opts.timeoutMs}ms waiting for ${opts.label}`);
}
