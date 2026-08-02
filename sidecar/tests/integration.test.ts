import { describe, test, expect, beforeAll } from "bun:test";
import { McpClient } from "../src/mcp-client.ts";
import { waitFor } from "./support/wait-for.ts";

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

  // The target is fixed rather than chats[0]: that is whichever conversation happens to be
  // most recent, so a real send lands in a stranger's chat and the test drifts every run.
  // Telegram Saved Messages is the author's own notes-to-self chat.
  const TEST_CHAT_ID = process.env.CHATMUX_TEST_CHAT_ID ?? "telegram:7869659098";

  test("send_message and verify delivery via read_messages", async () => {
    const { chats } = await client.listChats();
    expect(chats.length).toBeGreaterThan(0);

    const chat = chats.find((c) => c.id === TEST_CHAT_ID);
    expect(
      chat,
      `test chat ${TEST_CHAT_ID} not found — set CHATMUX_TEST_CHAT_ID to a chat this daemon can see`
    ).toBeDefined();

    const marker = `integration-test-${Date.now()}`;
    const sendResult = await client.sendMessage({
      chat_id: chat!.id,
      text: marker,
    });

    expect(sendResult.success).toBe(true);

    // A real Telegram round trip has no predictable upper bound — least of all just after
    // the daemon restarts, while the adapter is still backfilling. The old `sleep(500)` then
    // read once could only ever guess, and when it guessed low it failed for a reason that
    // had nothing to do with the code under test (F61). What changed is the waiting, not the
    // expectation: the message still has to come back.
    const found = await waitFor(
      async () => {
        const { messages } = await client.readMessages({ chat_id: chat!.id, limit: 5 });
        return messages.find((m) => m.text === marker);
      },
      {
        timeoutMs: 25_000,
        intervalMs: 500,
        label: `message "${marker}" to come back through read_messages`,
      },
    );

    expect(found.chat_id).toBe(chat!.id);
    expect(found.timestamp).toBeGreaterThan(0);
    // Deliberately longer than waitFor's own deadline, so a timeout reports what it was
    // waiting for instead of bun's information-free "test timed out".
  }, 30_000);
});
