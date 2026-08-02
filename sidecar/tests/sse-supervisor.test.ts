import { describe, test, expect } from "bun:test";
import { sseReopenDelayMs, SSE_DEGRADED_AFTER } from "../src/sse-supervisor.ts";
import { SubscriptionManager } from "../src/subscription.ts";
import type { McpClient } from "../src/mcp-client.ts";

describe("sseReopenDelayMs", () => {
  test("the first reopen is immediate — a clean stream end must not cost a second", () => {
    expect(sseReopenDelayMs(0)).toBe(0);
  });

  test("it backs off exponentially", () => {
    expect(sseReopenDelayMs(1)).toBe(1_000);
    expect(sseReopenDelayMs(2)).toBe(2_000);
    expect(sseReopenDelayMs(3)).toBe(4_000);
  });

  test("the cap is the poll interval, not backoffMs's 30s", () => {
    // An SSE backoff longer than the safety poll would make recovery *worse* than the
    // floor it sits on: the poll already delivers every 15s.
    expect(sseReopenDelayMs(10)).toBe(15_000);
    expect(sseReopenDelayMs(999)).toBe(15_000);
  });

  test("the degraded threshold is three, and it is a named constant not a literal", () => {
    expect(SSE_DEGRADED_AFTER).toBe(3);
  });
});

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.close(); } });
}

describe("SSE supervisor", () => {
  test("a stream that dies is reopened, and its death is never reported as a disconnect", async () => {
    let opens = 0;
    const client = {
      openSseStream: async () => {
        opens += 1;
        if (opens <= 3) throw new DOMException("timed out", "TimeoutError");
        return emptyStream();
      },
    } as unknown as McpClient;

    const seen: string[] = [];
    const mgr = new SubscriptionManager(client, (m) => { seen.push(m); });

    // Bounded so the test cannot hang: stop after the 4th open.
    await mgr._test_runSseSupervisor({ maxCycles: 5, sleep: async () => {} });

    // The whole of F63 part 1: it tried again. F42's lesson is that the absence of a
    // failure line is not evidence of success, so this asserts the attempts directly.
    expect(opens).toBeGreaterThanOrEqual(4);
    // F63 part 3: an SSE death is a latency change, not a connection loss.
    expect(seen).not.toContain("disconnected");
    expect(seen).toContain("sse_degraded");
    expect(seen.indexOf("sse_restored")).toBeGreaterThan(seen.indexOf("sse_degraded"));
  });

  test("a single failure stays silent — it fixes itself before anyone should be told", async () => {
    let opens = 0;
    const client = {
      openSseStream: async () => {
        opens += 1;
        if (opens === 1) throw new DOMException("timed out", "TimeoutError");
        return emptyStream();
      },
    } as unknown as McpClient;

    const seen: string[] = [];
    const mgr = new SubscriptionManager(client, (m) => { seen.push(m); });
    await mgr._test_runSseSupervisor({ maxCycles: 3, sleep: async () => {} });

    expect(seen).not.toContain("sse_degraded");
  });
});
