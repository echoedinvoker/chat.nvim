import { describe, expect, test } from "bun:test";
import { toMessage } from "../src/mcp-client";

// The point of this file is not the wording — to-message.test.ts already owns that.
// It is that a placeholder must be impossible to type. F59 was filed as a bug, kept
// for three days and scheduled into a round, because a text message reading
// "[sticker:?/?]" is pixel-identical to the placeholder the system draws.
const OPEN = "⟦"; // ⟦
const CLOSE = "⟧"; // ⟧

function raw(over: Record<string, unknown> = {}) {
  return {
    id: "telegram:m1",
    chat_id: "telegram:c1",
    sender: { id: "u1", display_name: "Someone" },
    timestamp: "2026-08-03T00:00:00Z",
    content: { type: "text", text: "hi" },
    ...over,
  } as any;
}

const CASES: Array<[string, () => string]> = [
  ["retracted", () =>
    toMessage(raw({ retracted_at: "2026-08-03T00:00:01Z" }), "telegram:c1").text],
  ["sticker", () =>
    toMessage(raw({ content: { type: "sticker", package_id: "5145", sticker_id: "7432559" } }), "telegram:c1", { path: "/tmp/s.png" } as any).text],
  ["sticker without ids", () =>
    toMessage(raw({ content: { type: "sticker" } }), "telegram:c1", { path: "/tmp/s.png" } as any).text],
  ["image", () =>
    toMessage(raw({ content: { type: "image" } }), "telegram:c1", { path: "/tmp/i.png" } as any).text],
  ["image pending", () =>
    toMessage(raw({ content: { type: "image" } }), "telegram:c1", undefined).text],
  ["image gone", () =>
    toMessage(raw({ content: { type: "image" } }), "telegram:c1", { unavailable: "gone" } as any).text],
  ["sticker gone", () =>
    toMessage(raw({ content: { type: "sticker" } }), "telegram:c1", { unavailable: "gone" } as any).text],
  ["video", () => toMessage(raw({ content: { type: "video" } }), "telegram:c1").text],
  ["audio", () => toMessage(raw({ content: { type: "audio" } }), "telegram:c1").text],
  ["file", () => toMessage(raw({ content: { type: "file" } }), "telegram:c1").text],
  ["unknown type", () =>
    toMessage(raw({ content: { type: "location" } }), "telegram:c1").text],
];

describe("placeholders cannot be typed", () => {
  for (const [name, produce] of CASES) {
    test(`${name} is wrapped in white square brackets`, () => {
      const text = produce();
      expect(text.startsWith(OPEN)).toBe(true);
      expect(text).toContain(CLOSE);
      expect(text).not.toContain("[");
      expect(text).not.toContain("]");
    });
  }

  // A caption rides after the placeholder (F44) and is user-written: it must not be
  // dragged inside the brackets, and it is allowed to contain anything.
  test("a caption stays outside the brackets", () => {
    const text = toMessage(
      raw({ content: { type: "image", text: "今天的貓" } }),
      "telegram:c1",
      { path: "/tmp/i.png" } as any,
    ).text;
    expect(text).toBe(`${OPEN}image${CLOSE} 今天的貓`);
  });
});
