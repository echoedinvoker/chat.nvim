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
    expect(result).toHaveProperty("results");
    expect(Array.isArray(result.results)).toBe(true);
  });
});

/**
 * Event tail (F9). Fully mocked: what matters here is that `read_events` is called with
 * the cursor the caller asked for and that an error response comes back as data, not as
 * a throw. The daemon-backed checks live in the describe block above.
 */
/**
 * Search translation. Fully mocked, like the event tail below: what matters is that the
 * layer carries every field the panel needs, not that a daemon is reachable.
 */
describe("McpClient search translation", () => {
  // ⚠️ Shape must be { result: { content: [...] } } — parseToolContent reads
  // response.result.content, so a missing `result` throws instead of parsing.
  const wrap = (payload: unknown) => ({
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });

  const searchPayload = {
    results: [
      {
        message: {
          id: "line:m1",
          chat_id: "line:c1",
          sender: { id: "line:u1", display_name: "Alice" },
          timestamp: 1_690_000_000_000,
          content: { type: "text", text: "晚上要不要吃火鍋" },
          edited_at: null,
          retracted_at: null,
        },
        snippet: "晚上要不要吃<b>火鍋</b>",
        chat_name: "秋海嗨自潛工作室",
      },
    ],
    total: 7,
    limit: 20,
    offset: 0,
  };

  test("searchMessages must carry snippet and chat_name through the translation layer", async () => {
    const client = new McpClient("/nonexistent.sock");
    const callTool = mock(() => Promise.resolve(wrap(searchPayload)));
    (client as any).callTool = callTool;

    const out = await client.searchMessages({ query: "火鍋", chat_id: "line:c1" });

    expect(callTool).toHaveBeenCalledWith("search_messages", {
      query: "火鍋",
      chat_id: "line:c1",
    });
    expect(out.total).toBe(7);
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.snippet).toBe("晚上要不要吃<b>火鍋</b>");
    expect(out.results[0]!.chat_name).toBe("秋海嗨自潛工作室");
    expect(out.results[0]!.message.sender_name).toBe("Alice");
    expect(out.results[0]!.message.text).toBe("晚上要不要吃火鍋");
  });
});

describe("McpClient on-demand media", () => {
  const wrap = (payload: unknown) => ({
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });

  test("fetchMedia must send chat_id alongside message_id", async () => {
    const client = new McpClient("/nonexistent.sock");
    const callTool = mock(() => Promise.resolve(wrap({ path: "/tmp/x.mp4" })));
    (client as any).callTool = callTool;

    const out = await client.fetchMedia({
      chat_id: "telegram:-100123",
      message_id: "telegram:100",
    });

    expect(out).toEqual({ path: "/tmp/x.mp4" });
    // F45: a Telegram message id names a message only together with its chat.
    expect(callTool).toHaveBeenCalledWith("get_media", {
      message_id: "telegram:100",
      chat_id: "telegram:-100123",
    });
  });

  test("fetchMedia turns unavailable into wording the UI can show", async () => {
    const client = new McpClient("/nonexistent.sock");
    (client as any).callTool = mock(() => Promise.resolve(wrap({ unavailable: "gone" })));

    const out = await client.fetchMedia({
      chat_id: "telegram:-100123",
      message_id: "telegram:100",
    });

    expect("unavailable" in out).toBe(true);
    if (!("unavailable" in out)) throw new Error("unreachable");
    expect(out.unavailable).toBe("gone");
    expect(out.text).toContain("Telegram");
  });

  test("a timeout says the fetch ran out of time, never that the file is gone", async () => {
    // Core reports a timeout separately from "gone" precisely so this wording can differ:
    // a video that took longer than the deadline has not been deleted, and telling the
    // reader it has is the has_more mistake (F34) wearing a different hat.
    const client = new McpClient("/nonexistent.sock");
    (client as any).callTool = mock(() => Promise.resolve(wrap({ unavailable: "timeout" })));

    const out = await client.fetchMedia({
      chat_id: "telegram:-100123",
      message_id: "telegram:100",
    });

    if (!("unavailable" in out)) throw new Error("unreachable");
    expect(out.unavailable).toBe("timeout");
    expect(out.text).not.toContain("不存在");
    expect(out.text).toContain("逾時");
  });
});

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
