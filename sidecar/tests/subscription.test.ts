import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionManager, type NotificationHandler } from "../src/subscription.ts";
import type { McpClient } from "../src/mcp-client.ts";

function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    subscribe: mock(() => Promise.resolve()),
    unsubscribe: mock(() => Promise.resolve()),
    readResource: mock(() => Promise.resolve({ chats: [] })),
    openSseStream: mock(() =>
      Promise.resolve(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }))
    ),
    ...overrides,
  } as unknown as McpClient;
}

describe("SubscriptionManager", () => {
  let notifications: Array<{ method: string; params: Record<string, unknown> }>;
  let handler: NotificationHandler;
  let cursorDir: string;
  let cursorPath: string;

  beforeEach(() => {
    notifications = [];
    handler = (method, params) => notifications.push({ method, params });
    cursorDir = mkdtempSync(join(tmpdir(), "f9-cursor-"));
    cursorPath = join(cursorDir, "cursor.json");
  });

  afterEach(() => {
    rmSync(cursorDir, { recursive: true, force: true });
  });

  /**
   * Shallow override: a key in `overrides` replaces the default mock outright. Typed loosely
   * on purpose — pinning mock signatures to McpClient's buys nothing here and costs a cast
   * at every call site.
   */
  function createTailClient(overrides: Record<string, unknown> = {}): McpClient {
    return createMockClient({
      readEvents: mock(() => Promise.resolve({
        events: [], next_cursor: "evt:100", head_cursor: "evt:100", has_more: false,
      })),
      resolveMedia: mock(() => Promise.resolve(new Map())),
      ...overrides,
    } as unknown as Partial<McpClient>);
  }

  /**
   * Always pass an isolated cursorPath. Without it the manager falls back to the real
   * ~/.local/share/chatmux/consumers/chat-nvim/cursor.json — which the tests would then
   * overwrite while nvim is using it.
   */
  function newManager(client: McpClient) {
    return new SubscriptionManager(client, handler, { cursorPath });
  }

  /** An SSE stream that emits the given data lines and closes. */
  function sseOf(...lines: string[]) {
    return new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n`));
        c.close();
      },
    });
  }

  const NOTIFY = (uri: string) =>
    JSON.stringify({ method: "notifications/resources/updated", params: { uri } });

  function ev(cursor: string, chatId: string, id: string, text: string) {
    return {
      cursor, type: "edit",
      message: {
        id, chat_id: chatId,
        sender: { id: "telegram:9", display_name: "Bot" },
        timestamp: 1769000000000,
        content: { type: "text", text },
        edited_at: 1769000001000, retracted_at: null,
      },
    };
  }

  test("subscribeDefaults subscribes to chats and status", async () => {
    const client = createMockClient();
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(client.subscribe).toHaveBeenCalledWith("chat://chats");
    expect(client.subscribe).toHaveBeenCalledWith("chat://status");
  });

  test("subscribeChat subscribes to messages resource", async () => {
    const client = createMockClient();
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeChat("line:U123");
    expect(client.subscribe).toHaveBeenCalledWith(
      "chat://chats/line:U123/messages"
    );
  });

  test("subscribeChat deduplicates", async () => {
    const client = createMockClient();
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeChat("line:U123");
    await mgr.subscribeChat("line:U123");
    expect(client.subscribe).toHaveBeenCalledTimes(1);
  });

  test("unsubscribeChat calls unsubscribe and removes from set", async () => {
    const client = createMockClient();
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeChat("line:U123");
    await mgr.unsubscribeChat("line:U123");
    expect(client.unsubscribe).toHaveBeenCalledWith(
      "chat://chats/line:U123/messages"
    );
    // re-subscribe should call subscribe again (not deduplicated)
    await mgr.subscribeChat("line:U123");
    expect(client.subscribe).toHaveBeenCalledTimes(2);
  });

  test("unsubscribeChat is no-op for unknown uri", async () => {
    const client = createMockClient();
    const mgr = new SubscriptionManager(client, handler);
    await mgr.unsubscribeChat("line:UNKNOWN");
    expect(client.unsubscribe).not.toHaveBeenCalled();
  });

  test("falls back to passive mode when subscribe fails", async () => {
    const client = createMockClient({
      subscribe: mock(() => Promise.reject(new Error("not supported"))),
    });
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    // should not throw, just log and enter fallback mode
    expect(client.subscribe).toHaveBeenCalledTimes(2);
  });

  // Contract change (F63, decision B): this used to assert the opposite. The stream is a
  // latency hint sitting on top of the poll, so losing it means "slower", never "gone" —
  // the old assertion pinned that lie in place.
  test("a stream that ends is not a disconnect", async () => {
    const client = createMockClient();
    const mgr = new SubscriptionManager(client, handler);
    await mgr.startSseLoop();
    expect(notifications.map((n) => n.method)).not.toContain("disconnected");
  });

  test("startSseLoop handles resource_updated with pre-fetch", async () => {
    const sseData = `data: ${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "chat://chats" },
    })}\n\n`;

    const client = createMockClient({
      openSseStream: mock(() => {
        const encoder = new TextEncoder();
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(sseData));
              controller.close();
            },
          })
        );
      }),
      readResource: mock(() =>
        Promise.resolve({ chats: [{ id: "line:U1", name: "Alice" }] })
      ),
    });

    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    await mgr.startSseLoop();

    // resource_updated only. Was 2 before F63, when the stream's end added a `disconnected`
    // (decision B).
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.method).toBe("resource_updated");
    expect(notifications[0]!.params.uri).toBe("chat://chats");
    expect(notifications[0]!.params.chats).toEqual([
      { id: "line:U1", name: "Alice", platform: undefined, last_message_time: undefined },
    ]);
    expect(typeof notifications[0]!.params.sidecar_received_at).toBe("number");
  });

  test("SSE ignores notifications for non-subscribed URIs", async () => {
    const sseData = `data: ${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "chat://chats/line:UNKNOWN/messages" },
    })}\n\n`;

    const client = createMockClient({
      openSseStream: mock(() => {
        const encoder = new TextEncoder();
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(sseData));
              controller.close();
            },
          })
        );
      }),
    });

    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    await mgr.startSseLoop();

    // Nothing at all: an unsubscribed uri is not pushed, and since F63 the stream's own end
    // is not announced either (decision B). Before F63 this expected one `disconnected`.
    expect(notifications).toEqual([]);
    expect(client.readResource).not.toHaveBeenCalled();
  });

  // === F9: the push path reads the event tail, not the newest-N snapshot ===

  test("a push reads the event tail instead of the resource snapshot", async () => {
    // Seed an existing cursor so the first call carries `since`. beforeEach gives an
    // empty dir, so without this the first call is the bootstrap's empty params.
    writeFileSync(cursorPath, JSON.stringify({ cursor: "evt:100" }) + "\n");
    const readEvents = mock(() => Promise.resolve({
      events: [ev("evt:101", "telegram:8529682445", "telegram:4484", "改過了")],
      next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
    }));
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:8529682445/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:8529682445");
    await mgr.startSseLoop();

    expect(readEvents).toHaveBeenCalledWith({ since: "evt:100" });
    expect(client.readResource).not.toHaveBeenCalled();

    const pushes = notifications.filter((n) => n.method === "resource_updated");
    expect(pushes.length).toBe(1);
    expect(pushes[0]!.params.uri).toBe("chat://chats/telegram:8529682445/messages");
    const msgs = pushes[0]!.params.messages as any[];
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toBe("改過了");
    expect(msgs[0].edited_at).toBe(1769000001000);
  });

  test("a chat://chats notification still reads the resource, not the event tail", async () => {
    // Guards the chat list. Core notifies chat://chats and .../messages on every change;
    // the former is the list's only update source (last_message preview, unopened-chat
    // hint, ordering). Routing it through the event tail would silently freeze it.
    const readEvents = mock(() => Promise.resolve({
      events: [], next_cursor: "evt:100", head_cursor: "evt:100", has_more: false,
    }));
    const readResource = mock(() => Promise.resolve({ chats: [], total: 0 }));
    const client = createTailClient({
      readEvents,
      readResource,
      openSseStream: mock(() => Promise.resolve(sseOf(NOTIFY("chat://chats")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeDefaults();
    await mgr.startSseLoop();

    expect(readResource).toHaveBeenCalledWith("chat://chats");
    expect(readEvents).not.toHaveBeenCalled();
    expect(notifications.some(
      (n) => n.method === "resource_updated" && n.params.uri === "chat://chats"
    )).toBe(true);
  });

  test("the cursor advances so the next push does not replay", async () => {
    writeFileSync(cursorPath, JSON.stringify({ cursor: "evt:100" }) + "\n");
    const readEvents = mock((_p: any) => Promise.resolve({
      events: [], next_cursor: "evt:150", head_cursor: "evt:150", has_more: false,
    }));
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() => Promise.resolve(sseOf(
        NOTIFY("chat://chats/telegram:1/messages"),
        NOTIFY("chat://chats/telegram:1/messages"),
      ))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:1");
    await mgr.startSseLoop();

    expect(readEvents.mock.calls[0]![0]).toEqual({ since: "evt:100" });
    expect(readEvents.mock.calls[1]![0]).toEqual({ since: "evt:150" });
  });

  test("events are grouped per chat, and unsubscribed chats are dropped", async () => {
    const client = createTailClient({
      readEvents: mock(() => Promise.resolve({
        events: [
          ev("evt:101", "telegram:AAA", "telegram:1", "A 的變更"),
          ev("evt:102", "telegram:BBB", "telegram:2", "B 的變更"),
          ev("evt:103", "telegram:ZZZ", "telegram:3", "沒訂閱的室"),
          ev("evt:104", "telegram:AAA", "telegram:4", "A 的第二筆"),
        ],
        next_cursor: "evt:104", head_cursor: "evt:104", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.subscribeChat("telegram:BBB");
    await mgr.startSseLoop();

    const pushes = notifications.filter((n) => n.method === "resource_updated");
    const byUri = new Map(pushes.map((p) => [p.params.uri as string, p.params]));

    expect(pushes.length).toBe(2);
    expect((byUri.get("chat://chats/telegram:AAA/messages")!.messages as any[]).length).toBe(2);
    expect((byUri.get("chat://chats/telegram:BBB/messages")!.messages as any[]).length).toBe(1);
    expect(byUri.has("chat://chats/telegram:ZZZ/messages")).toBe(false);
  });

  test("a tail with no events for any subscribed chat pushes nothing", async () => {
    const client = createTailClient({
      readEvents: mock(() => Promise.resolve({
        events: [ev("evt:101", "telegram:ZZZ", "telegram:9", "別室")],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    expect(notifications.filter((n) => n.method === "resource_updated").length).toBe(0);
  });

  // The cursor must move even when every event was filtered out. Otherwise events for
  // chats the user never opened pin the cursor in place and every push re-reads them.
  test("the cursor still advances when every event was filtered out", async () => {
    const client = createTailClient({
      readEvents: mock(() => Promise.resolve({
        events: [ev("evt:101", "telegram:ZZZ", "telegram:9", "別室")],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    expect(JSON.parse(readFileSync(cursorPath, "utf8")).cursor).toBe("evt:101");
  });

  // R15: toMessage without a third argument lands image/sticker on `pending`, i.e. the
  // text becomes "⟦圖片載入中…⟧". Telegram can edit a photo's caption, so an already
  // rendered picture would turn into a loading placeholder that never resolves — the
  // initial-load path resolves media, the tail path has to as well.
  function imageEv(cursor: string, chatId: string, id: string) {
    return {
      cursor, type: "edit",
      message: {
        id, chat_id: chatId,
        sender: { id: "telegram:9", display_name: "Bot" },
        timestamp: 1769000000000,
        content: { type: "image", text: null },
        edited_at: 1769000001000, retracted_at: null,
      },
    };
  }

  test("late media from the push path pushes its own redraw (F57)", async () => {
    let fireLate: (() => void) | null = null;
    const resolveMedia = mock((rows: any[], _chatId: string, onLate?: (m: Map<string, any>) => void) => {
      // The snapshot carries the first row only; the second one arrives after the
      // deadline, which is what a cold cache does on every reconnect.
      fireLate = () => onLate?.(new Map([[rows[1].id, { path: "/tmp/cached/late.png" }]]));
      return Promise.resolve(new Map([[rows[0].id, { path: "/tmp/cached/first.png" }]]));
    });
    const client = createTailClient({
      resolveMedia,
      readEvents: mock(() => Promise.resolve({
        events: [
          imageEv("evt:101", "telegram:AAA", "telegram:1"),
          imageEv("evt:102", "telegram:AAA", "telegram:2"),
        ],
        next_cursor: "evt:102", head_cursor: "evt:102", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    const before = notifications.filter((n) => n.method === "resource_updated").length;
    expect(before).toBe(1);

    fireLate!();

    const updates = notifications.filter((n) => n.method === "resource_updated");
    expect(updates.length).toBe(2);
    const late = updates[1]!.params as any;
    expect(late.uri).toBe("chat://chats/telegram:AAA/messages");
    expect(late.messages.map((m: any) => m.id)).toEqual(["telegram:2"]);
    expect(late.messages[0].media).toEqual({ state: "ready", path: "/tmp/cached/late.png" });
  });

  test("late media for an unsubscribed chat is dropped, like the main push (F57)", async () => {
    let fireLate: (() => void) | null = null;
    const resolveMedia = mock((rows: any[], _chatId: string, onLate?: (m: Map<string, any>) => void) => {
      fireLate = () => onLate?.(new Map([[rows[0].id, { path: "/tmp/cached/late.png" }]]));
      return Promise.resolve(new Map());
    });
    const client = createTailClient({
      resolveMedia,
      readEvents: mock(() => Promise.resolve({
        events: [imageEv("evt:101", "telegram:ZZZ", "telegram:1")],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");   // ZZZ is deliberately never subscribed
    await mgr.startSseLoop();

    fireLate!();

    expect(notifications.filter((n) =>
      n.method === "resource_updated" &&
      (n.params as any).uri === "chat://chats/telegram:ZZZ/messages")).toEqual([]);
  });

  test("a late push carries neither banner nor msg_timestamp (F57)", async () => {
    let fireLate: (() => void) | null = null;
    const resolveMedia = mock((rows: any[], _chatId: string, onLate?: (m: Map<string, any>) => void) => {
      fireLate = () => onLate?.(new Map([[rows[1].id, { path: "/tmp/cached/late.png" }]]));
      return Promise.resolve(new Map([[rows[0].id, { path: "/tmp/cached/first.png" }]]));
    });
    const client = createTailClient({
      resolveMedia,
      readEvents: mock(() => Promise.resolve({
        events: [
          imageEv("evt:101", "telegram:AAA", "telegram:1"),
          imageEv("evt:102", "telegram:AAA", "telegram:2"),
        ],
        next_cursor: "evt:102", head_cursor: "evt:102", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    fireLate!();

    const late = notifications.filter((n) => n.method === "resource_updated")[1]!.params as any;
    // An empty banner would clear F34's history line; msg_timestamp would hand
    // log_latency() a redraw that carried no new message and call it delivery lag.
    expect("banner" in late).toBe(false);
    expect("msg_timestamp" in late).toBe(false);
    expect(typeof late.sidecar_received_at).toBe("number");
  });

  test("the push path's late log is distinguishable from readMessages' (F57)", async () => {
    let fireLate: (() => void) | null = null;
    const resolveMedia = mock((rows: any[], _chatId: string, onLate?: (m: Map<string, any>) => void) => {
      fireLate = () => onLate?.(new Map([[rows[1].id, { path: "/tmp/cached/late.png" }]]));
      return Promise.resolve(new Map([[rows[0].id, { path: "/tmp/cached/first.png" }]]));
    });
    const client = createTailClient({
      resolveMedia,
      readEvents: mock(() => Promise.resolve({
        events: [
          imageEv("evt:101", "telegram:AAA", "telegram:1"),
          imageEv("evt:102", "telegram:AAA", "telegram:2"),
        ],
        next_cursor: "evt:102", head_cursor: "evt:102", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    // Captured around fireLate only: the manager logs plenty on the way here, and the
    // claim is about the one line the late push writes.
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      fireLate!();
    } finally {
      console.error = orig;
    }

    // Acceptance reads this log to tell which path filled a picture in. If the two lines
    // were spelled the same, reopening the chat during acceptance would look like the push
    // path working.
    const hits = lines.filter((l) => l.includes("late media"));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("late media (push): 1 image(s) for chat://chats/telegram:AAA/messages");
  });

  test("an edited image resolves its media instead of pushing a loading placeholder", async () => {
    const resolveMedia = mock((rows: any[]): Promise<Map<string, any>> =>
      Promise.resolve(new Map(rows.map((r) => [r.id, { path: "/tmp/cached/img-1.png" }])))
    );
    const client = createTailClient({
      resolveMedia,
      readEvents: mock(() => Promise.resolve({
        events: [imageEv("evt:101", "telegram:AAA", "telegram:1")],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    const pushed = (notifications.find((n) => n.method === "resource_updated")!
      .params.messages as any[])[0];

    expect(pushed.text).not.toBe("⟦圖片載入中…⟧");
    expect(pushed.media).toEqual({ state: "ready", path: "/tmp/cached/img-1.png" });
    expect(pushed.content_type).toBe("image");
    // Only image/sticker rows are handed over, not the whole batch
    expect(resolveMedia.mock.calls[0]![0].map((r: any) => r.id)).toEqual(["telegram:1"]);
  });

  test("a text-only edit does not ask for media at all", async () => {
    const resolveMedia = mock((rows: any[]): Promise<Map<string, any>> =>
      Promise.resolve(new Map()));
    const client = createTailClient({
      resolveMedia,
      readEvents: mock(() => Promise.resolve({
        events: [ev("evt:101", "telegram:AAA", "telegram:1", "純文字")],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    const calledWithWork =
      resolveMedia.mock.calls.length > 0 &&
      (resolveMedia.mock.calls[0]![0] ?? []).length > 0;
    expect(calledWithWork).toBe(false);
  });

  test("a retracted image does not get a media lookup", async () => {
    // toMessage deliberately gives a retracted message no mediaState, so looking the
    // media up would only waste a get_media call.
    const resolveMedia = mock(() => Promise.resolve(new Map()));
    const retracted = imageEv("evt:101", "telegram:AAA", "telegram:1");
    (retracted.message as any).retracted_at = 1769000002000;
    const client = createTailClient({
      resolveMedia,
      readEvents: mock(() => Promise.resolve({
        events: [retracted],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    const pushed = (notifications.find((n) => n.method === "resource_updated")!
      .params.messages as any[])[0];
    expect(pushed.text).toBe("⟦訊息已收回⟧");
    expect(pushed.media).toBeUndefined();
  });

  test("a retraction is grouped and pushed like any other change", async () => {
    // The retraction leg has no end-to-end route: Telegram's private-chat deletes never
    // reach chatmux at all (the adapter drops them for want of a peer), so this and the
    // core's read-events tests are the whole net under it.
    //
    // Two things are asserted because two different things could break. Grouping reads
    // message.chat_id and never event.type, so an unsend has to land on the same uri an
    // edit does. And core clears the text on retraction, so the push has to carry the
    // placeholder — an empty line is indistinguishable from a broken plugin, which is
    // exactly the shape F33 had.
    const unsent = {
      cursor: "evt:101", type: "unsend",
      message: {
        id: "telegram:1", chat_id: "telegram:AAA",
        sender: { id: "telegram:9", display_name: "Bot" },
        timestamp: 1769000000000,
        content: { type: "text", text: null },
        edited_at: null, retracted_at: 1769000002000,
      },
    };
    const client = createTailClient({
      readEvents: mock(() => Promise.resolve({
        events: [unsent],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    const push = notifications.find((n) => n.method === "resource_updated")!;
    expect(push.params.uri).toBe("chat://chats/telegram:AAA/messages");
    const pushed = (push.params.messages as any[])[0];
    expect(pushed.id).toBe("telegram:1");
    expect(pushed.text).toBe("⟦訊息已收回⟧");
  });

  test("has_more keeps draining until the tail is caught up", async () => {
    // Seeded, so the first read is a real one. Without a stored cursor the first call is
    // the bootstrap ("start from head, do not replay"), which would swallow page one.
    writeFileSync(cursorPath, JSON.stringify({ cursor: "evt:100" }) + "\n");
    let call = 0;
    const readEvents = mock((_p: any) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          events: [ev("evt:101", "telegram:AAA", "telegram:1", "第一批")],
          next_cursor: "evt:101", head_cursor: "evt:102", has_more: true,
        });
      }
      return Promise.resolve({
        events: [ev("evt:102", "telegram:AAA", "telegram:2", "第二批")],
        next_cursor: "evt:102", head_cursor: "evt:102", has_more: false,
      });
    });
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    expect(readEvents.mock.calls.length).toBe(2);
    expect(readEvents.mock.calls[1]![0]).toEqual({ since: "evt:101" });

    const texts = notifications
      .filter((n) => n.method === "resource_updated")
      .flatMap((n) => (n.params.messages as any[]).map((m) => m.text));
    expect(texts).toEqual(["第一批", "第二批"]);
  });

  test("a stalled cursor breaks out immediately, well before the round cap", async () => {
    // Always has_more with a cursor that never moves: without a guard this is an infinite
    // loop. Asserted as "well before the cap" rather than "within the cap", because the
    // latter also passes when the only thing stopping it is the cap itself.
    const readEvents = mock((_p: any) => Promise.resolve({
      events: [], next_cursor: "evt:100", head_cursor: "evt:100", has_more: true,
    }));
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    // bootstrap head (1) + two reads, the second of which sees the cursor stand still
    expect(readEvents.mock.calls.length).toBeLessThanOrEqual(3);
  });

  test("the round cap still holds when the cursor does keep moving", async () => {
    // The cursor advances every round and has_more never clears, so stall detection
    // cannot fire — only the cap can stop this.
    let n = 100;
    const readEvents = mock((_p: any) => {
      n += 1;
      return Promise.resolve({
        events: [], next_cursor: `evt:${n}`, head_cursor: "evt:99999", has_more: true,
      });
    });
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    expect(readEvents.mock.calls.length).toBeLessThanOrEqual(21);
  });

  test("an invalid cursor resyncs from head instead of stalling", async () => {
    // Seeded with a token this core did not issue, so the first read hits the error branch
    // rather than the bootstrap.
    writeFileSync(cursorPath, JSON.stringify({ cursor: "evt:100" }) + "\n");

    const calls: any[] = [];
    const readEvents = mock((p: any) => {
      calls.push(p);
      if (p.since === "evt:100") {
        return Promise.resolve({
          error: "invalid_cursor",
          detail: "not a cursor issued by this core: evt:100",
        });
      }
      return Promise.resolve({
        events: [], next_cursor: "evt:500", head_cursor: "evt:500", has_more: false,
      });
    });
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() => Promise.resolve(sseOf(
        NOTIFY("chat://chats/telegram:AAA/messages"),
        NOTIFY("chat://chats/telegram:AAA/messages"),
      ))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    // One head fetch (empty params) after the bad cursor
    expect(calls.some((p) => Object.keys(p).length === 0)).toBe(true);
    // And the bad cursor was used exactly once — no retrying it
    expect(calls.filter((p) => p.since === "evt:100").length).toBe(1);
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).cursor).toBe("evt:500");
    expect(notifications.some((n) => n.method === "error")).toBe(false);
  });

  test("a cursor ahead of head means the log shrank — resync to head", async () => {
    const readEvents = mock((p: any) => Promise.resolve({
      events: [], next_cursor: p.since ?? "evt:10", head_cursor: "evt:10", has_more: false,
    }));
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    writeFileSync(cursorPath, JSON.stringify({ cursor: "evt:9999" }) + "\n");
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    expect(JSON.parse(readFileSync(cursorPath, "utf8")).cursor).toBe("evt:10");
  });

  test("a readEvents throw does not kill the SSE loop", async () => {
    writeFileSync(cursorPath, JSON.stringify({ cursor: "evt:100" }) + "\n");
    let call = 0;
    const readEvents = mock(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("socket hiccup"));
      return Promise.resolve({
        events: [ev("evt:101", "telegram:AAA", "telegram:1", "之後還活著")],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      });
    });
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() => Promise.resolve(sseOf(
        NOTIFY("chat://chats/telegram:AAA/messages"),
        NOTIFY("chat://chats/telegram:AAA/messages"),
      ))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    const texts = notifications
      .filter((n) => n.method === "resource_updated")
      .flatMap((n) => (n.params.messages as any[]).map((m) => m.text));
    expect(texts).toEqual(["之後還活著"]);
  });

  // Persistence is what makes changes during downtime recoverable: a sidecar that always
  // started from head would silently skip every edit made while it was not running.
  test("the cursor is persisted as JSON and survives a restart", async () => {
    const first = createTailClient({
      readEvents: mock(() => Promise.resolve({
        events: [], next_cursor: "evt:200", head_cursor: "evt:200", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const m1 = newManager(first);
    await m1.subscribeChat("telegram:AAA");
    await m1.startSseLoop();

    expect(existsSync(cursorPath)).toBe(true);
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).cursor).toBe("evt:200");

    const secondRead = mock((_p: any) => Promise.resolve({
      events: [], next_cursor: "evt:201", head_cursor: "evt:201", has_more: false,
    }));
    const second = createTailClient({
      readEvents: secondRead,
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const m2 = newManager(second);
    await m2.subscribeChat("telegram:AAA");
    await m2.startSseLoop();

    // Resumed from the file, so the first call already carries `since` — no head fetch
    expect(secondRead.mock.calls[0]![0]).toEqual({ since: "evt:200" });
  });

  test("a corrupt cursor file is treated as no cursor, not a crash", async () => {
    writeFileSync(cursorPath, "{ this is not json");
    const readEvents = mock((_p: any) => Promise.resolve({
      events: [], next_cursor: "evt:777", head_cursor: "evt:777", has_more: false,
    }));
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    // Unreadable file ⇒ bootstrap from head (first call takes no params)
    expect(Object.keys(readEvents.mock.calls[0]![0]).length).toBe(0);
    expect(notifications.some((n) => n.method === "error")).toBe(false);
  });

  test("the cursor file is written atomically, never truncated in place", async () => {
    const client = createTailClient({
      readEvents: mock(() => Promise.resolve({
        events: [], next_cursor: "evt:300", head_cursor: "evt:300", has_more: false,
      })),
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    // The temp file must have been renamed away, not left behind
    expect(existsSync(`${cursorPath}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).cursor).toBe("evt:300");
  });

  // The cursor loop is the source of truth; the subscription is only a latency hint. A
  // consumer built purely on SSE stops updating the moment the stream dies quietly — F9
  // replayed, with just as little signal.
  test("a dead SSE stream does not stop updates — the poll still drains", async () => {
    const readEvents = mock(() => Promise.resolve({
      events: [ev("evt:101", "telegram:AAA", "telegram:1", "輪詢撿到的變更")],
      next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
    }));
    const client = createTailClient({
      readEvents,
      // The stream closes immediately: not one notification
      openSseStream: mock(() => Promise.resolve(sseOf())),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    expect(notifications.filter((n) => n.method === "resource_updated").length).toBe(0);

    await mgr._test_pollOnce();

    const texts = notifications
      .filter((n) => n.method === "resource_updated")
      .flatMap((n) => (n.params.messages as any[]).map((m) => m.text));
    expect(texts).toEqual(["輪詢撿到的變更"]);
  });

  test("a thrown drain releases the re-entrancy flag — it does not wedge forever", async () => {
    // R14: with the flag reset only on the success path, one transient readEvents failure
    // stops BOTH the SSE and the poll path permanently, with no signal at all — a worse
    // silent stall than F9 itself, and one this project would have introduced.
    writeFileSync(cursorPath, JSON.stringify({ cursor: "evt:100" }) + "\n");
    let call = 0;
    const readEvents = mock(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("transient socket error"));
      return Promise.resolve({
        events: [ev("evt:101", "telegram:AAA", "telegram:1", "失敗之後仍然收得到")],
        next_cursor: "evt:101", head_cursor: "evt:101", has_more: false,
      });
    });
    const client = createTailClient({
      readEvents,
      openSseStream: mock(() =>
        Promise.resolve(sseOf(NOTIFY("chat://chats/telegram:AAA/messages")))),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:AAA");
    await mgr.startSseLoop();

    await mgr._test_pollOnce();

    const texts = notifications
      .filter((n) => n.method === "resource_updated")
      .flatMap((n) => (n.params.messages as any[]).map((m) => m.text));
    expect(texts).toEqual(["失敗之後仍然收得到"]);
  });

  test("the event tail resolves media per chat, not in one cross-chat batch (F45)", async () => {
    const seen: Array<{ ids: string[]; chatId: string }> = [];
    const mediaEvent = (cursor: string, chatId: string, id: string) => ({
      cursor,
      type: "message",
      message: {
        id, chat_id: chatId,
        sender: { id: "telegram:u1", display_name: "x" },
        timestamp: 1_700_000_000_000,
        content: { type: "image" },
        edited_at: null, retracted_at: null,
      },
    });
    const client = createTailClient({
      readEvents: mock(() => Promise.resolve({
        events: [
          mediaEvent("evt:101", "telegram:-100A", "telegram:19245"),
          mediaEvent("evt:102", "telegram:-100B", "telegram:19245"),
        ],
        next_cursor: "evt:102", head_cursor: "evt:102", has_more: false,
      })),
      // Both chats answer the same id with a different image — an implementation that
      // merges them into one map gives itself away here.
      resolveMedia: mock((rows: any[], chatId: string) => {
        seen.push({ ids: rows.map((r) => r.id), chatId });
        return Promise.resolve(new Map(
          rows.map((r) => [r.id, { path: `/c/${chatId}.jpg`, mime: "image/jpeg" }]),
        ));
      }),
    });
    const mgr = newManager(client);
    await mgr.subscribeChat("telegram:-100A");
    await mgr.subscribeChat("telegram:-100B");
    await mgr._test_pollOnce();

    // One resolution per chat, each carrying its own chat — not one cross-chat batch.
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.chatId).sort()).toEqual(["telegram:-100A", "telegram:-100B"]);
    for (const s of seen) expect(s.ids).toEqual(["telegram:19245"]);

    // And each chat is pushed its own image, not the one the other chat resolved.
    const pushes = notifications.filter((n) => n.method === "resource_updated");
    const pathOf = (uri: string) => (pushes.find((p) => p.params.uri === uri)!
      .params.messages as any[])[0].media.path;
    expect(pathOf("chat://chats/telegram:-100A/messages")).toBe("/c/telegram:-100A.jpg");
    expect(pathOf("chat://chats/telegram:-100B/messages")).toBe("/c/telegram:-100B.jpg");
  });

describe("F60: the daemon being unreachable is its own state", () => {
  const socketGone = () =>
    Object.assign(new Error("Was there a typo in the url or port?"), {
      code: "FailedToOpenSocket",
    });

  test("a poll that cannot reach the daemon says so, exactly once", async () => {
    const client = createTailClient({
      readEvents: mock(() => Promise.reject(socketGone())),
    });
    const mgr = newManager(client);

    await mgr._test_pollOnce();
    await mgr._test_pollOnce();
    await mgr._test_pollOnce();

    const said = notifications.filter((n) => n.method === "daemon_unreachable");
    expect(said.length).toBe(1);
    // A dead socket is not a dead session: entering recoverSession here would retry
    // an initialize against a daemon that is not listening (F53 Phase 0.2 Q3).
    expect(notifications.some((n) => n.method === "reconnecting")).toBe(false);
  });

  test("the notification carries the code, so the log can name the cause", async () => {
    const client = createTailClient({
      readEvents: mock(() => Promise.reject(socketGone())),
    });
    await newManager(client)._test_pollOnce();

    const said = notifications.find((n) => n.method === "daemon_unreachable");
    expect(said?.params.code).toBe("FailedToOpenSocket");
  });

  test("a drain that works again clears the signal, and can raise it a second time", async () => {
    let down = true;
    const client = createTailClient({
      readEvents: mock(() =>
        down
          ? Promise.reject(
              Object.assign(new Error("Was there a typo in the url or port?"), {
                code: "FailedToOpenSocket",
              }),
            )
          : Promise.resolve({
              events: [], next_cursor: "evt:100",
              head_cursor: "evt:100", has_more: false,
            }),
      ),
    });
    const mgr = newManager(client);

    await mgr._test_pollOnce();                       // down  -> raise
    down = false;
    await mgr._test_pollOnce();                       // up    -> clear
    down = true;
    await mgr._test_pollOnce();                       // down  -> raise again

    const methods = notifications.map((n) => n.method);
    expect(methods.filter((m) => m === "daemon_unreachable").length).toBe(2);
    // A stuck flag is the failure mode that matters: it would make the *second*
    // outage silent, which is the exact bug this project exists to remove.
    expect(methods.indexOf("connected")).toBeGreaterThan(
      methods.indexOf("daemon_unreachable"),
    );
  });

  test("recovering through F53's session path also clears the flag", async () => {
    let phase: "down" | "session-gone" | "ok" = "down";
    const client = createTailClient({
      readEvents: mock(() => {
        if (phase === "down") {
          return Promise.reject(
            Object.assign(new Error("Was there a typo in the url or port?"), {
              code: "FailedToOpenSocket",
            }),
          );
        }
        if (phase === "session-gone") {
          return Promise.reject(
            Object.assign(new Error("Session not found"), { code: -32000 }),
          );
        }
        return Promise.resolve({
          events: [], next_cursor: "evt:100",
          head_cursor: "evt:100", has_more: false,
        });
      }),
      reconnect: mock(() => Promise.resolve()),
    });
    const mgr = newManager(client);

    await mgr._test_pollOnce();      // raise
    phase = "session-gone";
    await mgr._test_pollOnce();      // F53 recoverSession -> reconnecting, connected
    phase = "down";
    await mgr._test_pollOnce();      // must be able to raise again

    expect(
      notifications.filter((n) => n.method === "daemon_unreachable").length,
    ).toBe(2);
    expect(notifications.some((n) => n.method === "reconnecting")).toBe(true);
  });
});

describe("F54 sidenote: a subscribe that failed is still replayed on reconnect", () => {
  test("the uri stays in the set, so recovery retries it", async () => {
    const subscribe = mock(() => Promise.reject(new Error("subscribe blew up")));
    const client = createTailClient({
      subscribe,
      reconnect: mock(() => Promise.resolve()),
    });
    const mgr = newManager(client);

    await mgr.subscribeChat("chat-1");
    expect(subscribe).toHaveBeenCalledTimes(1);

    await mgr._test_recoverSession();

    // Keeping a never-succeeded uri looks like a bug and is not: a reconnect is
    // exactly when a subscription that never took should be tried again. This test
    // exists so the next reader does not "fix" it back into a leak.
    expect(subscribe.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("F54: a subscribe that dies of a dead session escalates", () => {
  test("session loss during subscribe triggers recovery", async () => {
    const client = createTailClient({
      subscribe: mock(() =>
        Promise.reject(Object.assign(new Error("Session not found"), { code: -32000 })),
      ),
      reconnect: mock(() => Promise.resolve()),
    });
    const mgr = newManager(client);

    await mgr.subscribeChat("chat-1");

    expect(notifications.some((n) => n.method === "reconnecting")).toBe(true);
  });

  test("an ordinary subscribe failure must NOT tear the session down", async () => {
    const client = createTailClient({
      subscribe: mock(() => Promise.reject(new Error("Chat not found"))),
      reconnect: mock(() => Promise.resolve()),
    });
    const mgr = newManager(client);

    await mgr.subscribeChat("chat-1");

    expect(notifications.some((n) => n.method === "reconnecting")).toBe(false);
  });
});
});

describe("resource pushes carry the history banner", () => {
  function pushOf(uri: string, payload: unknown) {
    const sseData = `data: ${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri },
    })}\n\n`;

    return createMockClient({
      openSseStream: mock(() => {
        const encoder = new TextEncoder();
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(sseData));
              controller.close();
            },
          })
        );
      }),
      readResource: mock(() => Promise.resolve(payload)),
    });
  }

  let notifications: Array<{ method: string; params: Record<string, unknown> }>;
  let handler: NotificationHandler;
  let bannerCursorDir: string;
  let bannerCursorPath: string;

  beforeEach(() => {
    notifications = [];
    handler = (method, params) => notifications.push({ method, params });
    // Isolated, like the other describe: the default path is the real cursor file that
    // nvim is using.
    bannerCursorDir = mkdtempSync(join(tmpdir(), "f9-banner-cursor-"));
    bannerCursorPath = join(bannerCursorDir, "cursor.json");
  });

  afterEach(() => {
    rmSync(bannerCursorDir, { recursive: true, force: true });
  });

  // F9 changed where a `.../messages` push gets its data: the event tail, not the
  // newest-N resource snapshot. The tail knows *what changed*, so it cannot speak for the
  // chat's history state — a messages push therefore carries no `banner` key at all, and
  // Lua reads an absent key as "leave the banner alone" (docs/ui-conventions.md). The
  // banner still reaches Lua on the initial load and on `[`, both of which go through
  // readMessages. These two tests pin that split so it stays deliberate.
  test("a messages push omits banner entirely — an absent key must not clear F34's line", async () => {
    const client = createMockClient({
      openSseStream: mock(() =>
        Promise.resolve(new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
              method: "notifications/resources/updated",
              params: { uri: "chat://chats/line:U1/messages" },
            })}\n`));
            c.close();
          },
        }))),
      readEvents: mock(() => Promise.resolve({
        events: [], next_cursor: "evt:1", head_cursor: "evt:1", has_more: false,
      })),
    });
    const mgr = new SubscriptionManager(client, handler, { cursorPath: bannerCursorPath });
    await mgr.subscribeChat("line:U1");
    await mgr.startSseLoop();

    // No events for that chat ⇒ nothing to push at all, and crucially no empty-banner push
    expect(notifications.filter((n) => n.method === "resource_updated").length).toBe(0);
    expect(client.readResource).not.toHaveBeenCalled();
  });

  test("a messages push still carries msg_timestamp, which the latency log needs", async () => {
    const client = createMockClient({
      openSseStream: mock(() =>
        Promise.resolve(new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
              method: "notifications/resources/updated",
              params: { uri: "chat://chats/line:U2/messages" },
            })}\n`));
            c.close();
          },
        }))),
      readEvents: mock(() => Promise.resolve({
        events: [{
          cursor: "evt:1", type: "edit",
          message: {
            id: "line:m1", chat_id: "line:U2",
            sender: { id: "line:s1", display_name: "Alice" },
            timestamp: 1_700_000_000_000,
            content: { type: "text", text: "hi" },
            edited_at: 1_700_000_001_000, retracted_at: null,
          },
        }],
        next_cursor: "evt:1", head_cursor: "evt:1", has_more: false,
      })),
    });
    const mgr = new SubscriptionManager(client, handler, { cursorPath: bannerCursorPath });
    await mgr.subscribeChat("line:U2");
    await mgr.startSseLoop();

    const push = notifications.find((n) => n.method === "resource_updated")!;
    expect(push.params.msg_timestamp).toBe(1_700_000_000_000);
    expect(push.params).not.toHaveProperty("banner");
  });

  test("chat://chats carries no banner", async () => {
    const client = pushOf("chat://chats", { chats: [] });
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    await mgr.startSseLoop();

    expect(notifications[0]!.params).not.toHaveProperty("banner");
  });

  // The push path and the initial load must answer the same shape, or the list silently
  // changes size depending on which one ran last — the asymmetry F11 was really about.
  test("chat://chats carries the completeness fields", async () => {
    const client = pushOf("chat://chats", {
      chats: [{ id: "line:a", name: "a", platform: "line" }],
      total: 1,
    });
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    await mgr.startSseLoop();

    expect(notifications[0]!.params.total).toBe(1);
    expect(notifications[0]!.params.truncated).toBe(false);
    expect(notifications[0]!.params.truncation_banner).toBeNull();
  });

  test("a truncated chat://chats push says so", async () => {
    const client = pushOf("chat://chats", {
      chats: [{ id: "line:a", name: "a", platform: "line" }],
      total: 143,
    });
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    await mgr.startSseLoop();

    expect(notifications[0]!.params.truncated).toBe(true);
    expect(notifications[0]!.params.truncation_banner).toContain("143");
  });

  // Dropping the old `Array.isArray(obj.chats)` guard means malformed pushes are
  // normalised instead of forwarded raw. Pinned so that change stays deliberate.
  test("a malformed chat://chats push normalises to an empty list", async () => {
    const client = pushOf("chat://chats", { chats: "not-an-array" });
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    await mgr.startSseLoop();

    expect(notifications[0]!.params.chats).toEqual([]);
    expect(notifications[0]!.params.truncated).toBe(false);
  });

  test("chat://status carries no banner", async () => {
    const client = pushOf("chat://status", { adapters: {} });
    const mgr = new SubscriptionManager(client, handler);
    await mgr.subscribeDefaults();
    await mgr.startSseLoop();

    expect(notifications[0]!.params).not.toHaveProperty("banner");
  });

});
