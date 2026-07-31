import { describe, test, expect } from "bun:test";
import { McpClient, resolvePageMediaStreaming } from "../src/mcp-client.ts";

/**
 * readMessages 的 MCP 往返被 stub 掉：這裡要測的是「core 回什麼 → sidecar 透出什麼」
 * 的翻譯層，不是 daemon 活不活。打真實 daemon 的健康檢查在 mcp-client.test.ts。
 */
function clientReturning(toolResult: unknown): McpClient {
  const c = new McpClient();
  // ⚠️ 形狀必須是 { result: { content: [...] } }：parseToolContent 讀的是
  // response.result.content（mcp-client.ts:206-213），少一層 result 會 throw
  // "Unexpected MCP tool response"。
  // @ts-expect-error — 覆寫 private 往返，測翻譯層
  c.callTool = async () => ({
    result: { content: [{ type: "text", text: JSON.stringify(toolResult) }] },
  });
  return c;
}

describe("readMessages 透出分頁欄位", () => {
  test("has_more 與 oldest_timestamp 原樣透出", async () => {
    const c = clientReturning({
      messages: [{
        id: "line:m1", chat_id: "line:c1",
        sender: { id: "line:u1", display_name: "Alice" },
        timestamp: 1_690_000_000_000,
        content: { type: "text", text: "hi" },
      }],
      has_more: true,
      oldest_timestamp: 1_690_000_000_000,
      newest_timestamp: 1_690_000_000_000,
      history: { state: "partial" },
    });

    const r = await c.readMessages({ chat_id: "line:c1", limit: 50 });

    expect(r.has_more).toBe(true);
    expect(r.oldest_timestamp).toBe(1_690_000_000_000);
    expect(r.messages).toHaveLength(1);
  });

  test("空聊天室：has_more false，oldest_timestamp 是 null 而非 undefined", async () => {
    const c = clientReturning({
      messages: [], has_more: false,
      oldest_timestamp: null, newest_timestamp: null,
      history: { state: "unknown" },
    });

    const r = await c.readMessages({ chat_id: "line:c-empty" });

    expect(r.has_more).toBe(false);
    expect(r.oldest_timestamp).toBeNull();
  });

  test("core 完全沒給 has_more 時保守當作沒有更舊的", async () => {
    const c = clientReturning({ messages: [], history: { state: "unknown" } });

    const r = await c.readMessages({ chat_id: "line:c1" });

    expect(r.has_more).toBe(false);
    expect(r.oldest_timestamp).toBeNull();
  });
});

describe("readMessages 透出 older_hint", () => {
  test("has_more 時 hint 反映呼叫端給的 limit", async () => {
    const c = clientReturning({
      messages: [], has_more: true,
      oldest_timestamp: 1_690_000_000_000, newest_timestamp: null,
      history: { state: "unknown" },
    });

    const r = await c.readMessages({ chat_id: "line:c1", limit: 50 });

    expect(r.older_hint).toBe("↑ 還有更舊的訊息（按 [ 載入 50 筆）");
  });

  test("沒給 limit 時文案用 core 的預設 20，不能是 undefined", async () => {
    const c = clientReturning({
      messages: [], has_more: true,
      oldest_timestamp: 1_690_000_000_000, newest_timestamp: null,
      history: { state: "partial" },
    });

    const r = await c.readMessages({ chat_id: "line:c1" });

    expect(r.older_hint).toBe("↑ 還有更舊的訊息（按 [ 載入 20 筆）");
    expect(r.older_hint).not.toContain("undefined");
  });

  test("本機載完且 state unknown → 不宣稱這是全部", async () => {
    const c = clientReturning({
      messages: [], has_more: false,
      oldest_timestamp: null, newest_timestamp: null,
      history: { state: "unknown" },
    });

    const r = await c.readMessages({ chat_id: "line:c1", limit: 50 });

    expect(r.older_hint).toBe("── 已載入本機全部；更舊的是否存在未知 ──");
  });
});

describe("readMessages 把聊天室帶進 get_media（F45）", () => {
  test("read_messages passes the chat down to get_media (F45)", async () => {
    const calls: any[] = [];
    const c = new McpClient();
    // @ts-expect-error — 覆寫 private 往返，測翻譯層（同 clientReturning）
    c.callTool = async (name: string, params: unknown) => {
      if (name === "get_media") {
        calls.push(params);
        return { result: { content: [{ type: "text", text: JSON.stringify({ path: "/c/x.jpg", mime: "image/jpeg" }) }] } };
      }
      return {
        result: { content: [{ type: "text", text: JSON.stringify({
          messages: [{
            id: "telegram:19245",
            chat_id: "telegram:-1001782953277",
            sender: { id: "telegram:u1", display_name: "A" },
            timestamp: 1_700_000_000_000,
            content: { type: "image" },
          }],
          has_more: false,
        }) }] },
      };
    };

    await c.readMessages({ chat_id: "telegram:-1001782953277" });

    expect(calls).toHaveLength(1);
    expect((calls[0] as any).chat_id).toBe("telegram:-1001782953277");
    expect((calls[0] as any).message_id).toBe("telegram:19245");
  });
});

// ── F43：串流解析（首頁先回、背景續解、併發不失控）───────────────────
describe("resolvePageMediaStreaming", () => {
  test("late arrivals come back through onLate, and the first pass returns at the deadline (F43)", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `telegram:${i}`, chat_id: "telegram:-100A",
      sender: { id: "telegram:u1", display_name: "x" }, timestamp: i,
      content: { type: "image" },
    })) as any[];

    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let deadlineDone!: () => void;
    const deadline = new Promise<void>((r) => { deadlineDone = r; });

    let inFlight = 0, maxInFlight = 0;
    const fetchOne = async (id: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      if (id !== "telegram:0") await slow;
      inFlight--;
      return { path: `/c/${id}.jpg`, mime: "image/jpeg" };
    };

    const late: string[] = [];
    const first = resolvePageMediaStreaming(rows, fetchOne, {
      concurrency: 2,
      deadline,
      onLate: (m) => { for (const k of m.keys()) late.push(k); },
    });

    await Bun.sleep(5);      // 讓第一批 worker 起跑
    deadlineDone();
    const firstMap = await first;
    expect(firstMap.has("telegram:0")).toBe(true);
    expect(firstMap.size).toBeLessThan(rows.length);

    release();
    await Bun.sleep(20);
    expect(late.length).toBe(rows.length - firstMap.size);
    expect(maxInFlight).toBeLessThanOrEqual(2);   // 截止後併發仍受限
  });

  test("one image that never answers does not starve the rest (F43)", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: `telegram:${i}`, content: { type: "image" },
    })) as any[];

    const late: string[] = [];
    const out = await resolvePageMediaStreaming(
      rows,
      async (id) => (id === "telegram:0" ? new Promise<never>(() => {}) : { path: `/c/${id}.jpg`, mime: "image/jpeg" }),
      {
        concurrency: 1,               // 卡住的那筆獨佔唯一的槽
        itemTimeoutMs: 30,            // 生產值 30s，測試注入 30ms
        deadline: Bun.sleep(200),
        onLate: (m) => { for (const k of m.keys()) late.push(k); },
      },
    );

    // 沒有 per-item timeout 的話，telegram:0 會永久佔住唯一的 worker 槽，
    // 後面三筆既不進 out 也不進 late — 靜默餓死。
    expect(out.has("telegram:0")).toBe(false);
    expect([...out.keys()].sort()).toEqual(["telegram:1", "telegram:2", "telegram:3"]);
  });
});

// ── F43：解得慢的那些圖，解完要自己推一次重繪 ────────────────────────
describe("readMessages pushes one redraw for late media (F43)", () => {
  test("a page whose images arrive late pushes exactly one resource_updated", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });

    const c = new McpClient();
    // @ts-expect-error — 覆寫 private 往返，測翻譯層（同 clientReturning）
    c.callTool = async (name: string, params: any) => {
      const reply = (obj: unknown) => ({
        result: { content: [{ type: "text", text: JSON.stringify(obj) }] },
      });
      if (name === "get_media") {
        // 第二張刻意慢到頁面截止之後才回來
        if (params.message_id === "telegram:2") await slow;
        return reply({ path: `/c/${params.message_id}.jpg`, mime: "image/jpeg" });
      }
      const row = (id: string) => ({
        id, chat_id: "telegram:-100A",
        sender: { id: "telegram:u1", display_name: "A" },
        timestamp: 1_700_000_000_000,
        content: { type: "image" },
      });
      return reply({ messages: [row("telegram:1"), row("telegram:2")], has_more: false });
    };

    const pushed: { method: string; params: any }[] = [];
    c.setLateMediaHandler((method, params) => pushed.push({ method, params }));

    // 頁面預算注入成 0，才不用真的等 3 秒證明「截止時先給畫面」
    const page = await c.readMessages({ chat_id: "telegram:-100A", media_deadline_ms: 0 });
    expect(page.messages.find((m: any) => m.id === "telegram:2")!.media)
      .toEqual({ state: "pending" });
    expect(pushed).toHaveLength(0);          // 截止當下還沒有東西可推

    release();
    await Bun.sleep(20);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.method).toBe("resource_updated");
    expect(pushed[0]!.params.uri).toBe("chat://chats/telegram:-100A/messages");
    // 只推那些晚到的訊息，不是整頁重送
    expect(pushed[0]!.params.messages).toHaveLength(1);
    expect(pushed[0]!.params.messages[0].id).toBe("telegram:2");
    expect(pushed[0]!.params.messages[0].media).toEqual({
      state: "ready", path: "/c/telegram:2.jpg",
    });
    // F34：帶 banner 會清掉歷史列，payload 形狀必須與 pushEvents 一致
    expect("banner" in pushed[0]!.params).toBe(false);
    expect(typeof pushed[0]!.params.sidecar_received_at).toBe("number");
  });

  test("a page that resolves in time pushes nothing", async () => {
    const c = new McpClient();
    // @ts-expect-error — 覆寫 private 往返
    c.callTool = async (name: string, params: any) => {
      const reply = (obj: unknown) => ({
        result: { content: [{ type: "text", text: JSON.stringify(obj) }] },
      });
      if (name === "get_media") return reply({ path: `/c/${params.message_id}.jpg`, mime: "image/jpeg" });
      return reply({
        messages: [{
          id: "telegram:1", chat_id: "telegram:-100A",
          sender: { id: "telegram:u1", display_name: "A" },
          timestamp: 1, content: { type: "image" },
        }],
        has_more: false,
      });
    };
    const pushed: unknown[] = [];
    c.setLateMediaHandler(() => pushed.push(1));
    const page = await c.readMessages({ chat_id: "telegram:-100A" });
    await Bun.sleep(20);
    expect((page.messages[0] as any).media.state).toBe("ready");
    expect(pushed).toHaveLength(0);
  });
});
