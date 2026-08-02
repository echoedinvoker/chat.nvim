import { describe, test, expect } from "bun:test";
import { describeError } from "../src/describe-error.ts";

describe("describeError", () => {
  test("a DOMException collapses to one line, not its 25 constants", () => {
    const err = new DOMException("The operation timed out", "TimeoutError");
    const out = describeError(err);
    expect(out).toBe("TimeoutError: The operation timed out");
    // The actual F63 symptom: console.error(err) printed INDEX_SIZE_ERR..DATA_CLONE_ERR.
    expect(out).not.toContain("INDEX_SIZE_ERR");
    expect(out.includes("\n")).toBe(false);
  });

  test("an ordinary Error keeps name and message", () => {
    expect(describeError(new Error("boom"))).toBe("Error: boom");
  });

  test("an Error carrying a code says so — isSessionGone/isDaemonUnreachable dispatch on it", () => {
    const err = Object.assign(new Error("Session not found"), { code: -32000 });
    expect(describeError(err)).toBe("Error: Session not found (code -32000)");
  });

  test("a DOMException's legacy numeric code is NOT appended", () => {
    // Measured 2026-08-02, bun 1.3.9: every DOMException carries a legacy `code`
    // (TimeoutError is 23). Appending it would be noise, and would contradict the
    // first test in this file.
    expect(new DOMException("x", "TimeoutError").code).toBe(23);
    expect(describeError(new DOMException("x", "TimeoutError"))).toBe("TimeoutError: x");
  });

  test("a string code — the daemon-unreachable shape — is kept", () => {
    const err = Object.assign(new Error("connect failed"), { code: "FailedToOpenSocket" });
    expect(describeError(err)).toBe("Error: connect failed (code FailedToOpenSocket)");
  });

  test("non-Error values survive without throwing", () => {
    expect(describeError("nope")).toBe("nope");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });
});
