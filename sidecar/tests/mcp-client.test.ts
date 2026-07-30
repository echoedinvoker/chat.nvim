import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { McpClient } from "../src/mcp-client.ts";

describe("McpClient", () => {
  let client: McpClient;

  beforeAll(async () => {
    client = new McpClient();
    await client.connect();
  });

  test("connect and get_status", async () => {
    const result = await client.getStatus();
    expect(result).toHaveProperty("daemon");
  });

  test("list_chats returns chats array", async () => {
    const result = await client.listChats();
    expect(result).toHaveProperty("chats");
    expect(Array.isArray(result.chats)).toBe(true);
    if (result.chats.length > 0) {
      const chat = result.chats[0];
      expect(chat).toHaveProperty("id");
      expect(chat).toHaveProperty("name");
      expect(chat).toHaveProperty("platform");
    }
  });

  test("read_messages returns messages for a chat", async () => {
    const { chats } = await client.listChats();
    if (chats.length === 0) return; // skip if no chats

    const firstChat = chats[0]!;
    const result = await client.readMessages({
      chat_id: firstChat.id,
      limit: 5,
    });
    expect(result).toHaveProperty("messages");
    expect(Array.isArray(result.messages)).toBe(true);
    if (result.messages.length > 0) {
      const msg = result.messages[0]!;
      expect(msg).toHaveProperty("id");
      expect(msg).toHaveProperty("sender_name");
      expect(msg).toHaveProperty("text");
      expect(msg).toHaveProperty("timestamp");
      expect(typeof msg.timestamp).toBe("number");
    }
  });

  test("search_messages returns results", async () => {
    const result = await client.searchMessages({ query: "test", limit: 5 });
    expect(result).toHaveProperty("messages");
    expect(Array.isArray(result.messages)).toBe(true);
  });
});

/**
 * Event tail (F9). Fully mocked: what matters here is that `read_events` is called with
 * the cursor the caller asked for and that an error response comes back as data, not as
 * a throw. The daemon-backed checks live in the describe block above.
 */
describe("McpClient event tail", () => {
  // ⚠️ Shape must be { result: { content: [...] } } — parseToolContent reads
  // response.result.content, so a missing `result` throws instead of parsing.
  const wrap = (payload: unknown) => ({
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });

  test("readEvents calls the read_events tool and passes the cursor through", async () => {
    const client = new McpClient("/nonexistent.sock");
    const callTool = mock(() => Promise.resolve(wrap({
      events: [], next_cursor: "evt:7", head_cursor: "evt:7", has_more: false,
    })));
    (client as any).callTool = callTool;

    const res = await client.readEvents({ since: "evt:5" });

    expect(callTool).toHaveBeenCalledWith("read_events", { since: "evt:5" });
    expect("error" in res).toBe(false);
    if ("error" in res) throw new Error("unreachable");
    expect(res.next_cursor).toBe("evt:7");
    expect(res.has_more).toBe(false);
  });

  test("readEvents omits since when starting fresh", async () => {
    const client = new McpClient("/nonexistent.sock");
    const callTool = mock(() => Promise.resolve(wrap({
      events: [], next_cursor: "evt:9", head_cursor: "evt:9", has_more: false,
    })));
    (client as any).callTool = callTool;

    await client.readEvents({});

    expect(callTool).toHaveBeenCalledWith("read_events", {});
  });

  test("an error response is returned as-is, not thrown", async () => {
    const client = new McpClient("/nonexistent.sock");
    (client as any).callTool = mock(() => Promise.resolve(wrap({
      error: "invalid_cursor", detail: "not a cursor issued by this core: evt:9",
    })));

    const res = await client.readEvents({ since: "evt:9" });

    // The caller has to branch on this to resync from head, so it must not throw here.
    expect("error" in res).toBe(true);
  });
});
