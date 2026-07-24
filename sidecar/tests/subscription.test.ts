import { describe, test, expect, mock, beforeEach } from "bun:test";
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

  beforeEach(() => {
    notifications = [];
    handler = (method, params) => notifications.push({ method, params });
  });

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

  test("startSseLoop emits disconnected when stream ends", async () => {
    const client = createMockClient();
    const mgr = new SubscriptionManager(client, handler);
    await mgr.startSseLoop();
    expect(notifications).toEqual([
      { method: "disconnected", params: { reason: "SSE stream ended" } },
    ]);
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

    // should have: resource_updated + disconnected
    expect(notifications.length).toBe(2);
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

    // only disconnected, no resource_updated for unknown URI
    expect(notifications).toEqual([
      { method: "disconnected", params: { reason: "SSE stream ended" } },
    ]);
    expect(client.readResource).not.toHaveBeenCalled();
  });
});
