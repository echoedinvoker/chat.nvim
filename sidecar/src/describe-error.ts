// F63: `console.error("…:", err)` hands the object to Bun's inspector, and a DOMException
// carries all 25 legacy constants (INDEX_SIZE_ERR..DATA_CLONE_ERR) as own properties. One
// SSE timeout therefore washed ~30 lines through a log that is already 18000+ lines long,
// which is how the failures went unread for days. One failure should cost one line.
//
// The `code` is kept because both dispatchers in reconnect.ts read it: isSessionGone
// matches -32000/-32001, isDaemonUnreachable matches the string codes FailedToOpenSocket /
// ECONNREFUSED / ENOENT. Seeing it in the log is what makes after-the-fact reconciliation
// possible. DOMException is the one exception: its legacy numeric code (TimeoutError is 23)
// says nothing about that dispatch and would only be noise.
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const base = `${err.name}: ${err.message}`;
    if (err instanceof DOMException) return base;
    const code = (err as { code?: unknown }).code;
    return code === undefined ? base : `${base} (code ${String(code)})`;
  }
  if (typeof err === "string") return err;
  return String(err);
}
