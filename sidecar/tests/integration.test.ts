import { describe, test, expect } from "bun:test";
import { McpClient, DEFAULT_SOCKET } from "../src/mcp-client.ts";
import { waitFor } from "./support/wait-for.ts";

// This file needs a live daemon, and that used to be an unwritten rule: the tests simply went
// red when it was absent, and a reader had to decide which kind of red it was. Twice that
// decision went the wrong way (F61, F69) and absorbed a real defect — sending was broken and
// the only test that would have said so was already being read as an environment problem.
//
// So the dependency is checked here instead, and it is checked by reaching the daemon rather
// than by reading a flag: a flag records what someone remembered to set, reachability is a
// fact. Unreachable prints its reason and skips; reachable means these tests must run and
// any red is real.
//
// The probe is at module load, not in beforeAll, for a measured reason: when beforeAll throws,
// bun 1.3.9 reports one unnamed failure and no test in the file is named at all — not passed,
// not individually failed, just gone. That is the same shape as the defect this round is
// about, an output that hides what happened. `describe.skipIf` also needs a plain boolean,
// which a top-level await can produce and an async hook cannot.
let client: McpClient | null = null;
let unreachable: string | null = null;
try {
  // Kept and reused rather than closed: the client is stateless HTTP over a unix socket, so
  // there is no open connection to leak — and connecting twice would only mean two sessions.
  client = new McpClient();
  await client.connect();
} catch (err) {
  unreachable = err instanceof Error ? err.message : String(err);
  client = null;
  // Named socket and the way back: a bare fetch error here reads "Was there a typo in the url
  // or port?", which describes nothing a reader of this file can act on.
  const socket = process.env.CHATMUX_SOCKET ?? DEFAULT_SOCKET;
  console.log(
    `skipped: chatmux daemon unreachable at ${socket} (${unreachable}) — ` +
    `start it with \`systemctl --user start chatmux\` to run these`,
  );
}

describe.skipIf(unreachable !== null)("integration: real chatmux daemon", () => {
  test("list_chats returns non-empty", async () => {
    const { chats } = await client!.listChats();
    expect(chats.length).toBeGreaterThan(0);
    expect(chats[0]).toHaveProperty("id");
    expect(chats[0]).toHaveProperty("name");
  });

  // The target is fixed rather than chats[0]: that is whichever conversation happens to be
  // most recent, so a real send lands in a stranger's chat and the test drifts every run.
  // Telegram Saved Messages is the author's own notes-to-self chat.
  const TEST_CHAT_ID = process.env.CHATMUX_TEST_CHAT_ID ?? "telegram:7869659098";

  test("send_message and verify delivery via read_messages", async () => {
    const { chats } = await client!.listChats();
    expect(chats.length).toBeGreaterThan(0);

    const chat = chats.find((c) => c.id === TEST_CHAT_ID);
    expect(
      chat,
      `test chat ${TEST_CHAT_ID} not found — set CHATMUX_TEST_CHAT_ID to a chat this daemon can see`
    ).toBeDefined();

    const marker = `integration-test-${Date.now()}`;
    const sendResult = await client!.sendMessage({
      chat_id: chat!.id,
      text: marker,
    });

    // Since F70 this is true by construction — sendMessage throws on a failed send, so a red
    // here now arrives as the throw, carrying core's own reason instead of just `false`. The
    // assertion stays anyway: delete it and this test loses its only direct statement that
    // the send is supposed to succeed, which is the gate itself, not a restatement of a type.
    expect(sendResult.success).toBe(true);

    // A real Telegram round trip has no predictable upper bound — least of all just after
    // the daemon restarts, while the adapter is still backfilling. The old `sleep(500)` then
    // read once could only ever guess, and when it guessed low it failed for a reason that
    // had nothing to do with the code under test (F61). What changed is the waiting, not the
    // expectation: the message still has to come back.
    const found = await waitFor(
      async () => {
        const { messages } = await client!.readMessages({ chat_id: chat!.id, limit: 5 });
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
