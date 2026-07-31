import { describe, test, expect } from "bun:test";
import { McpClient } from "../src/mcp-client.ts";

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
