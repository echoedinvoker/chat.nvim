import { describe, test, expect } from "bun:test";
import { waitFor } from "./support/wait-for.ts";

describe("waitFor", () => {
  test("it polls until the value shows up, rather than sleeping a guessed amount", async () => {
    let calls = 0;
    const got = await waitFor(
      async () => { calls += 1; return calls >= 3 ? "here" : undefined; },
      { timeoutMs: 1_000, intervalMs: 10, label: "the thing" },
    );
    expect(got).toBe("here");
    // F61's whole point: a fixed sleep cannot tell "not yet" from "never".
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("it gives up at the deadline and says what it was waiting for", async () => {
    await expect(
      waitFor(async () => undefined, { timeoutMs: 50, intervalMs: 10, label: "the thing" }),
    ).rejects.toThrow(/the thing/);
  });
});
