import { describe, test, expect } from "bun:test";
import { McpClient, toChatList, shouldUseListAll } from "../src/mcp-client.ts";
import { dispatch } from "../src/index.ts";

const rawChat = (id: string, ts?: number) => ({
  id,
  name: `name-${id}`,
  platform: "line",
  ...(ts !== undefined && { last_message: { text: "hi", timestamp: ts, sender: "s" } }),
});

describe("toChatList", () => {
  test("a complete list is not truncated and carries no banner", () => {
    const r = toChatList({ chats: [rawChat("a"), rawChat("b"), rawChat("c")], total: 3 });
    expect(r.chats.length).toBe(3);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.truncation_banner).toBeNull();
  });

  test("a short list is truncated and the banner names both numbers", () => {
    const r = toChatList({ chats: [rawChat("a"), rawChat("b")], total: 143 });
    expect(r.truncated).toBe(true);
    expect(typeof r.truncation_banner).toBe("string");
    expect(r.truncation_banner).toContain("2");
    expect(r.truncation_banner).toContain("143");
  });

  // An empty list is a legitimate answer, not a truncation. Warning here would be
  // the same class of lie F12 removed from the backfill state machine.
  test("an empty list raises no false warning", () => {
    const r = toChatList({ chats: [], total: 0 });
    expect(r.chats).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.truncation_banner).toBeNull();
  });

  test("missing fields do not throw", () => {
    const r = toChatList({});
    expect(r.chats).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.truncated).toBe(false);
  });

  test("chats are mapped to the Chat shape, not passed through raw", () => {
    const r = toChatList({ chats: [rawChat("line:x", 1690000000000)], total: 1 });
    expect(r.chats[0]!.id).toBe("line:x");
    expect(r.chats[0]!.last_message_time).toBe(1690000000000);
    expect(r.chats[0]).not.toHaveProperty("last_message");
  });
});

describe("shouldUseListAll", () => {
  test("no filter and no explicit page means the whole list", () => {
    expect(shouldUseListAll({})).toBe(true);
  });

  test("any filter or explicit page keeps the paginated tool path", () => {
    expect(shouldUseListAll({ limit: 10 })).toBe(false);
    expect(shouldUseListAll({ cursor: 2 })).toBe(false);
    expect(shouldUseListAll({ platform: "line" })).toBe(false);
    expect(shouldUseListAll({ query: "x" })).toBe(false);
  });

  // 0 is falsy, so it reads as "unspecified" — same technique the existing
  // `if (params.limit)` sparse mapping uses. Pinned so nobody "fixes" it later.
  test("limit 0 reads as unspecified", () => {
    expect(shouldUseListAll({ limit: 0 })).toBe(true);
  });
});

// Testing `shouldUseListAll` alone does not prove `dispatch` consults it — a mutation
// that ignores the helper entirely leaves those tests green. These drive dispatch.
describe("dispatch routes list_chats by params", () => {
  const spyClient = () => {
    const calls: string[] = [];
    return {
      calls,
      client: {
        listAllChats: async () => {
          calls.push("listAllChats");
          return { chats: [], total: 0, truncated: false, truncation_banner: null };
        },
        listChats: async () => {
          calls.push("listChats");
          return { chats: [] };
        },
      } as unknown as McpClient,
    };
  };
  const subMgr = {} as any;

  test("empty params take the resource path", async () => {
    const { calls, client } = spyClient();
    await dispatch(client, subMgr, { id: 1, method: "list_chats", params: {} });
    expect(calls).toEqual(["listAllChats"]);
  });

  test("an explicit limit keeps the paginated tool path", async () => {
    const { calls, client } = spyClient();
    await dispatch(client, subMgr, { id: 1, method: "list_chats", params: { limit: 5 } });
    expect(calls).toEqual(["listChats"]);
  });

  test("a search query keeps the paginated tool path", async () => {
    const { calls, client } = spyClient();
    await dispatch(client, subMgr, { id: 1, method: "list_chats", params: { query: "x" } });
    expect(calls).toEqual(["listChats"]);
  });
});

describe("McpClient.listAllChats", () => {
  test("reads the chat://chats resource and never calls the tool", async () => {
    const client = new McpClient();
    let readUri: string | null = null;
    let toolCalled = false;

    (client as any).readResource = async (uri: string) => {
      readUri = uri;
      return { chats: [rawChat("line:a", 1), rawChat("line:b", 2)], total: 2 };
    };
    (client as any).callTool = async () => {
      toolCalled = true;
      return {};
    };

    const r = await client.listAllChats();

    expect(readUri).toBe("chat://chats");
    expect(toolCalled).toBe(false);
    expect(r.chats.length).toBe(2);
    expect(r.truncated).toBe(false);
  });
});
