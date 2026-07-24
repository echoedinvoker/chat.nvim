import { describe, test, expect, beforeAll } from "bun:test";
import { McpClient } from "../src/mcp-client.ts";

describe("integration: real chatmux daemon", () => {
  let client: McpClient;

  beforeAll(async () => {
    client = new McpClient();
    await client.connect();
  });

  test("list_chats returns non-empty", async () => {
    const { chats } = await client.listChats();
    expect(chats.length).toBeGreaterThan(0);
    expect(chats[0]).toHaveProperty("id");
    expect(chats[0]).toHaveProperty("name");
  });

  test("send_message and verify delivery via read_messages", async () => {
    const { chats } = await client.listChats();
    expect(chats.length).toBeGreaterThan(0);

    const chat = chats[0]!;
    const marker = `integration-test-${Date.now()}`;
    const sendResult = await client.sendMessage({
      chat_id: chat.id,
      text: marker,
    });

    expect(sendResult.success).toBe(true);

    // Give daemon a moment to persist
    await Bun.sleep(500);

    const { messages } = await client.readMessages({
      chat_id: chat.id,
      limit: 5,
    });

    const found = messages.find((m) => m.text === marker);
    expect(found).toBeDefined();
    expect(found!.chat_id).toBe(chat.id);
    expect(found!.timestamp).toBeGreaterThan(0);
  });
});
