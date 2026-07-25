import { describe, test, expect } from "bun:test";
import { toMessage } from "../src/mcp-client.ts";
import type { McpMessageRaw } from "../src/types.ts";

function raw(overrides: Partial<McpMessageRaw> = {}): McpMessageRaw {
  return {
    id: "telegram:4484",
    chat_id: "telegram:-100123",
    sender: { id: "telegram:u1", display_name: "Alice" },
    timestamp: 1_700_000_000_000,
    content: { type: "text", text: "原始內容" },
    ...overrides,
  };
}

describe("toMessage passes change state through to Lua", () => {
  test("an unchanged message reports both fields as null", () => {
    const m = toMessage(raw(), "telegram:-100123");

    expect(m.text).toBe("原始內容");
    expect(m.edited_at).toBeNull();
    expect(m.retracted_at).toBeNull();
  });

  test("an edited message carries edited_at and the new text", () => {
    const m = toMessage(
      raw({ content: { type: "text", text: "編輯後" }, edited_at: 1_700_000_100_000 }),
      "telegram:-100123",
    );

    expect(m.text).toBe("編輯後");
    expect(m.edited_at).toBe(1_700_000_100_000);
    expect(m.retracted_at).toBeNull();
  });

  test("a retracted message renders as a placeholder, not an empty line", () => {
    const m = toMessage(
      raw({ content: { type: "text", text: null as unknown as undefined }, retracted_at: 1_700_000_200_000 }),
      "telegram:-100123",
    );

    expect(m.text).toBe("[訊息已收回]");
    expect(m.retracted_at).toBe(1_700_000_200_000);
  });

  test("retraction beats the media placeholder", () => {
    const m = toMessage(
      raw({ content: { type: "image" }, retracted_at: 1_700_000_300_000 }),
      "telegram:-100123",
    );

    expect(m.text).toBe("[訊息已收回]");
  });

  test("a message edited and then retracted keeps both stamps", () => {
    const m = toMessage(
      raw({ content: { type: "text" }, edited_at: 1_700_000_400_000, retracted_at: 1_700_000_500_000 }),
      "telegram:-100123",
    );

    expect(m.text).toBe("[訊息已收回]");
    expect(m.edited_at).toBe(1_700_000_400_000);
    expect(m.retracted_at).toBe(1_700_000_500_000);
  });
});
