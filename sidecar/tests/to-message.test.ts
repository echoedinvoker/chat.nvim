import { describe, test, expect } from "bun:test";
import { toMessage, historyBanner, olderHint, resolvePageMedia } from "../src/mcp-client.ts";
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

describe("historyBanner turns core's history state into one line of prose", () => {
  test("unavailable says why nothing is there", () => {
    expect(historyBanner({ state: "unavailable" })).toBe(
      "── 歷史不可得：此裝置註冊前的訊息 LINE 不下發 ──",
    );
  });

  test("backfilling says a fetch is running", () => {
    expect(historyBanner({ state: "backfilling" })).toBe("── 正在補抓歷史… ──");
  });

  test("partial says older messages are still missing", () => {
    expect(historyBanner({ state: "partial" })).toBe("── 更舊的訊息尚未補抓 ──");
  });

  test("complete shows nothing — the chat is simply short", () => {
    expect(historyBanner({ state: "complete" })).toBeNull();
  });

  test("unknown shows nothing — nothing has been established yet", () => {
    expect(historyBanner({ state: "unknown" })).toBeNull();
  });

  test("a missing or null history shows nothing", () => {
    expect(historyBanner(undefined)).toBeNull();
    expect(historyBanner(null)).toBeNull();
  });

  test("an unrecognised state shows nothing rather than a wrong claim", () => {
    expect(historyBanner({ state: "something_new" } as never)).toBeNull();
  });
});

describe("olderHint 頂端狀態行", () => {
  test("還有更舊的 → 提示可按 [", () => {
    const h = olderHint({ has_more: true, state: "unknown" }, 50);
    expect(h).toBe("↑ 還有更舊的訊息（按 [ 載入 50 筆）");
  });

  test("PAGE_SIZE 反映在文案裡", () => {
    expect(olderHint({ has_more: true, state: "partial" }, 100))
      .toBe("↑ 還有更舊的訊息（按 [ 載入 100 筆）");
  });

  test("complete 是唯一能宣稱「最開頭」的狀態", () => {
    expect(olderHint({ has_more: false, state: "complete" }, 50))
      .toBe("── 已是這個聊天室的最開頭 ──");
  });

  test("unknown：只敢說本機載完，不敢說這是全部", () => {
    const h = olderHint({ has_more: false, state: "unknown" }, 50);
    expect(h).toBe("── 已載入本機全部；更舊的是否存在未知 ──");
    // storage-schema.md：只有 exhausted/complete 有資格說 this is everything
    expect(h).not.toBe("── 已是這個聊天室的最開頭 ──");
  });

  test("缺 state 欄位比照 unknown 處理", () => {
    expect(olderHint({ has_more: false, state: undefined }, 50))
      .toBe("── 已載入本機全部；更舊的是否存在未知 ──");
  });

  for (const state of ["partial", "backfilling", "unavailable"]) {
    test(`${state} 已由既有 banner 說明，hint 留空不重複`, () => {
      expect(olderHint({ has_more: false, state }, 50)).toBeNull();
    });
  }
});

// ── F35 Phase 5.1：媒體三態與 placeholder 文案 ────────────────────────
describe("toMessage — 媒體三態（F35）", () => {
  test("帶出 content_type，讓 Lua 算得出影像高度", () => {
    // 不從 text 反推：placeholder 文案是會改的（本輪就改了兩個），
    // 拿文案當結構化資料用，失效方式會是「高度悄悄變成 12」。
    expect(toMessage(raw({ content: { type: "sticker", sticker_id: "1" } }), "c").content_type)
      .toBe("sticker");
    expect(toMessage(raw({ content: { type: "image" } }), "c").content_type).toBe("image");
    expect(toMessage(raw(), "c").content_type).toBe("text");
  });

  test("快取有檔時標 ready 並帶路徑", () => {
    const m = toMessage(raw({ content: { type: "image" } }), "telegram:-100123", {
      path: "/c/line/msg/m1.jpg", mime: "image/jpeg",
    });
    expect(m.media).toEqual({ state: "ready", path: "/c/line/msg/m1.jpg" });
  });

  test("LINE 端已刪時明說，不留空白", () => {
    const m = toMessage(raw({ content: { type: "image" } }), "telegram:-100123", {
      unavailable: "gone",
    });
    expect(m.media).toEqual({ state: "gone" });
    expect(m.text).toBe("[圖片已不存在於 LINE]");
  });

  test("貼圖用貼圖的說法", () => {
    const m = toMessage(raw({ content: { type: "sticker", sticker_id: "1" } }), "telegram:-100123", {
      unavailable: "gone",
    });
    expect(m.text).toBe("[貼圖已不存在於 LINE]");
  });

  test("還沒回來時是載入中，不是壞了", () => {
    const m = toMessage(raw({ content: { type: "image" } }), "telegram:-100123", undefined);
    expect(m.media).toEqual({ state: "pending" });
    expect(m.text).toBe("[圖片載入中…]");
  });

  test("收回優先於媒體", () => {
    const m = toMessage(
      raw({ content: { type: "image" }, retracted_at: 99 }),
      "telegram:-100123",
      { path: "/c/x.jpg", mime: "image/jpeg" },
    );
    expect(m.text).toBe("[訊息已收回]");
    expect(m.media).toBeUndefined();
  });
});

// ── F35 Phase 5.2：一頁內解析媒體（併發上限 4、總預算 3s）─────────────
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `line:m${i}`, content: { type: "image" } }) as any);

describe("resolvePageMedia", () => {
  test("keeps at most 4 requests in flight", async () => {
    let inFlight = 0, peak = 0;
    const out = await resolvePageMedia(rows(10), async (id) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await Bun.sleep(10);
      inFlight--;
      return { path: `/c/${id}.jpg`, mime: "image/jpeg" };
    }, { concurrency: 4, deadline: new Promise(() => {}) });

    expect(peak).toBeLessThanOrEqual(4);
    expect(out.size).toBe(10);
  });

  test("gives up on a straggler without holding the page hostage", async () => {
    let fireDeadline: () => void = () => {};
    const deadline = new Promise<void>((r) => { fireDeadline = r; });

    const p = resolvePageMedia(rows(10), async (id) => {
      if (id === "line:m3") return await new Promise(() => {});   // 永不 resolve
      return { path: `/c/${id}.jpg`, mime: "image/jpeg" };
    }, { concurrency: 4, deadline });

    await Bun.sleep(20);
    fireDeadline();
    const out = await p;

    expect(out.get("line:m3")).toBeUndefined();
    expect(out.size).toBe(9);
  });
});
