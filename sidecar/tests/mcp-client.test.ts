import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
