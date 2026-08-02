import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionGone, isDaemonUnreachable, backoffMs, MAX_RECONNECT_ATTEMPTS } from "../src/reconnect.ts";
import { McpClient } from "../src/mcp-client.ts";
import { SubscriptionManager } from "../src/subscription.ts";

describe("isSessionGone", () => {
  test("core's own -32000 counts", () => {
    expect(isSessionGone({ code: -32000, message: "Session not found" })).toBe(true);
  });

  test("the SDK's -32001 counts too", () => {
    expect(isSessionGone({ code: -32001, message: "Session not found" })).toBe(true);
  });

  test("an ordinary tool error does not", () => {
    expect(isSessionGone({ code: -32602, message: "Invalid params" })).toBe(false);
  });

  test("a bare Error with the message counts, since that is what rawRequest throws today", () => {
    expect(isSessionGone(new Error("Session not found"))).toBe(true);
  });

  test("a different 'not found' must not count", () => {
    expect(isSessionGone(new Error("Chat not found"))).toBe(false);
  });

  test("undefined is not a session loss", () => {
    expect(isSessionGone(undefined)).toBe(false);
  });
});

describe("isDaemonUnreachable", () => {
  // Measured 2026-08-01: this is verbatim what Bun throws for a unix socket that is
  // not there — message included, so a future Bun wording change fails loudly here
  // instead of silently turning the detector off.
  const socketGone = Object.assign(
    new Error("Was there a typo in the url or port?"),
    { code: "FailedToOpenSocket", errno: 0, path: "/run/user/1000/chatmux.sock" },
  );
  const refused = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  const noEntry = Object.assign(new Error("no such file or directory"), {
    code: "ENOENT",
  });
  const sessionGone = { code: -32000, message: "Session not found" };
  const toolError = { code: -32602, message: "Invalid params" };

  test("Bun's unix-socket failure counts", () => {
    expect(isDaemonUnreachable(socketGone)).toBe(true);
  });

  test("a refused connection counts", () => {
    expect(isDaemonUnreachable(refused)).toBe(true);
  });

  test("a missing socket path counts", () => {
    expect(isDaemonUnreachable(noEntry)).toBe(true);
  });

  test("a vanished session is NOT unreachable — the daemon is alive", () => {
    expect(isDaemonUnreachable(sessionGone)).toBe(false);
  });

  test("an ordinary tool error does not count", () => {
    expect(isDaemonUnreachable(toolError)).toBe(false);
  });

  test("undefined is not unreachable", () => {
    expect(isDaemonUnreachable(undefined)).toBe(false);
  });

  test("a bare Error with no code is not unreachable", () => {
    expect(isDaemonUnreachable(new Error("something else"))).toBe(false);
  });

  // The whole point of F60 is that these are two different outages with two different
  // durations. If one error ever satisfied both, the state machine would race itself.
  test("the two predicates are mutually exclusive on every fixture", () => {
    for (const e of [socketGone, refused, noEntry, sessionGone, toolError, undefined]) {
      expect(isSessionGone(e) && isDaemonUnreachable(e)).toBe(false);
    }
  });
});

describe("backoffMs", () => {
  test("the first attempt does not wait", () => {
    expect(backoffMs(1)).toBe(0);
  });

  test("it grows", () => {
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
    expect(backoffMs(3)).toBeGreaterThan(backoffMs(2));
  });

  test("it is capped, so a long outage does not push the next try past a minute", () => {
    for (let n = 1; n <= 50; n += 1) {
      expect(backoffMs(n)).toBeLessThanOrEqual(30_000);
    }
  });

  test("every value is a usable delay", () => {
    for (let n = 1; n <= 50; n += 1) {
      const ms = backoffMs(n);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("the attempt ceiling is a real number the caller can stop on", () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(1);
    expect(Number.isFinite(MAX_RECONNECT_ATTEMPTS)).toBe(true);
  });
});

function sessionGoneFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
}

describe("McpClient error shape", () => {
  test("a JSON-RPC error keeps its code, so the caller can tell session loss from a bad call", async () => {
    const client = new McpClient("/tmp/f53-does-not-exist.sock", { fetchImpl: sessionGoneFetch() });
    let caught: any;
    try {
      await client.getStatus();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toBe("Session not found");
    expect(caught.code).toBe(-32000);
  });
});

describe("McpClient.reconnect", () => {
  test("re-initializes without the dead id, and then uses the new one", async () => {
    const seen: Array<{ sid: string | null; body: any }> = [];
    let issued = 0;
    const fakeFetch = (async (_url: string, init: any) => {
      const sid = init?.headers?.["mcp-session-id"] ?? null;
      const body = JSON.parse(init.body);
      seen.push({ sid, body });
      if (body.method === "initialize") {
        issued += 1;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          status: 200,
          headers: { "mcp-session-id": `session-${issued}` },
        });
      }
      // Must be a legal tool-content envelope: getStatus() runs the reply through
      // parseToolContent (mcp-client.ts:369-378), which throws on anything else — and
      // that throw would kill the test before the assertion below is reached.
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: body.id,
        result: { content: [{ type: "text", text: "{}" }] },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new McpClient("/tmp/f53-does-not-exist.sock", { fetchImpl: fakeFetch });
    await client.connect();
    await client.reconnect();

    const inits = seen.filter((s) => s.body.method === "initialize");
    expect(inits.length).toBe(2);
    expect(inits[1]!.sid).toBeNull();          // the dead id must not be sent

    seen.length = 0;
    await client.getStatus();
    expect(seen[0]!.sid).toBe("session-2");    // and the new one must be
  });
});

// Same isolation tests/subscription.test.ts uses, and for the same reason its comment
// gives: without an explicit path the manager falls back to the real
// ~/.local/share/chatmux/consumers/chat-nvim/cursor.json and overwrites what nvim is using.
describe("reconnect (cursor-backed)", () => {
let cursorDir: string;
beforeEach(() => { cursorDir = mkdtempSync(join(tmpdir(), "f53-cursor-")); });
afterEach(() => { rmSync(cursorDir, { recursive: true, force: true }); });

describe("SubscriptionManager.resubscribeAll", () => {
  test("every uri is subscribed again — a new session knows nothing about the old one", async () => {
    const subscribe = mock(() => Promise.resolve());
    const client = {
      subscribe,
      unsubscribe: mock(() => Promise.resolve()),
      readResource: mock(() => Promise.resolve({ chats: [] })),
      readEvents: mock(() => Promise.resolve({
        events: [], next_cursor: "evt:1", head_cursor: "evt:1", has_more: false,
      })),
      resolveMedia: mock(() => Promise.resolve(new Map())),
      openSseStream: mock(() =>
        Promise.resolve(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }))),
    } as any;

    const mgr = new SubscriptionManager(client, () => {}, { cursorPath: join(cursorDir, "c1.json") });
    await mgr.subscribeDefaults();
    await mgr.subscribeChat("chat-1");
    expect(subscribe).toHaveBeenCalledTimes(3);

    await mgr.resubscribeAll();
    expect(subscribe).toHaveBeenCalledTimes(6);   // not 3 — the early return must not apply here
  });

  test("it reports what it did, so 'no subscribe failures' can be told apart from 'never tried'", async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const client = {
        subscribe: mock(() => Promise.resolve()),
        unsubscribe: mock(() => Promise.resolve()),
        readResource: mock(() => Promise.resolve({ chats: [] })),
        openSseStream: mock(() =>
          Promise.resolve(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }))),
      } as any;
      const mgr = new SubscriptionManager(client, () => {}, { cursorPath: join(cursorDir, "c2.json") });
      await mgr.subscribeDefaults();
      await mgr.resubscribeAll();
    } finally {
      console.error = orig;
    }
    expect(lines.some((l) => /resubscribed 2 uri\(s\)/.test(l))).toBe(true);
  });
});

describe("session loss during a drain", () => {
  function goneOnce() {
    let thrown = false;
    return mock(() => {
      if (!thrown) {
        thrown = true;
        const e = new Error("Session not found") as Error & { code?: number };
        e.code = -32000;
        return Promise.reject(e);
      }
      return Promise.resolve({
        events: [], next_cursor: "evt:1", head_cursor: "evt:1", has_more: false,
      });
    });
  }

  test("it reconnects and resubscribes — reopening the stream is the supervisor's job", async () => {
    const reconnect = mock(() => Promise.resolve());
    const subscribe = mock(() => Promise.resolve());
    const openSseStream = mock(() =>
      Promise.resolve(new ReadableStream<Uint8Array>({ start(c) { c.close(); } })));
    const client = {
      reconnect, subscribe, openSseStream,
      unsubscribe: mock(() => Promise.resolve()),
      readResource: mock(() => Promise.resolve({ chats: [] })),
      readEvents: goneOnce(),
      resolveMedia: mock(() => Promise.resolve(new Map())),
    } as any;

    const mgr = new SubscriptionManager(client, () => {}, { cursorPath: join(cursorDir, "c3.json") });
    await mgr.subscribeDefaults();
    subscribe.mockClear();

    await mgr._test_pollOnce();

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);       // both defaults, again
    // Contract change (F63, decision A). This asserted `toHaveBeenCalled()` before: recovery
    // used to open its own stream. `runSseSupervisor` is already looping, and it picks up the
    // new session id on its next open — so a stream opened here would be a *second* one
    // running against the same session. This inversion is decision A's mechanical proof.
    expect(openSseStream).not.toHaveBeenCalled();
  });

  test("two detectors racing produce one reconnect, not two sessions", async () => {
    // The drain path is already serialised by `draining`, so this races the seam
    // itself: two concurrent recoveries would each call initialize — the second
    // one stranding the first's brand-new session, invisible until pushes stop.
    const reconnect = mock(() => new Promise<void>((r) => setTimeout(r, 5)));
    const client = {
      reconnect,
      subscribe: mock(() => Promise.resolve()),
      unsubscribe: mock(() => Promise.resolve()),
      readResource: mock(() => Promise.resolve({ chats: [] })),
      readEvents: mock(() => Promise.resolve({
        events: [], next_cursor: "evt:1", head_cursor: "evt:1", has_more: false,
      })),
      resolveMedia: mock(() => Promise.resolve(new Map())),
      openSseStream: mock(() =>
        Promise.resolve(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }))),
    } as any;

    const mgr = new SubscriptionManager(client, () => {}, { cursorPath: join(cursorDir, "c4.json") });
    await Promise.all([mgr._test_recoverSession(), mgr._test_recoverSession()]);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  test("an ordinary drain error does not tear down the session", async () => {
    const reconnect = mock(() => Promise.resolve());
    const client = {
      reconnect,
      subscribe: mock(() => Promise.resolve()),
      unsubscribe: mock(() => Promise.resolve()),
      readResource: mock(() => Promise.resolve({ chats: [] })),
      readEvents: mock(() => Promise.reject(new Error("Invalid params"))),
      resolveMedia: mock(() => Promise.resolve(new Map())),
      openSseStream: mock(() =>
        Promise.resolve(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }))),
    } as any;
    const mgr = new SubscriptionManager(client, () => {}, { cursorPath: join(cursorDir, "c6.json") });
    await mgr._test_pollOnce();
    expect(reconnect).toHaveBeenCalledTimes(0);
  });
});
});
