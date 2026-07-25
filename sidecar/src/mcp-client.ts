import type {
  Chat,
  McpChatRaw,
  McpHistoryRaw,
  McpMessageRaw,
  McpSendResult,
  McpSearchResultItem,
  Message,
} from "./types.ts";

const DEFAULT_SOCKET = `${process.env.HOME}/.local/share/chatmux/chatmux.sock`;

export class McpClient {
  private socketPath: string;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? process.env.CHATMUX_SOCKET ?? DEFAULT_SOCKET;
  }

  async connect(): Promise<void> {
    const result = await this.rawRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "chat-nvim-sidecar", version: "0.1.0" },
    });

    if (!result) throw new Error("MCP initialize failed: no response");

    await this.rawNotification("notifications/initialized", {});
  }

  async listChats(params: {
    platform?: string;
    query?: string;
    limit?: number;
    cursor?: number;
  } = {}): Promise<{ chats: Chat[] }> {
    const mcpParams: Record<string, unknown> = {};
    if (params.platform) mcpParams.search = params.platform;
    if (params.query) mcpParams.search = params.query;
    if (params.limit) mcpParams.limit = params.limit;
    if (params.cursor) mcpParams.offset = params.cursor;

    const raw = await this.callTool("list_chats", mcpParams);
    const parsed = this.parseToolContent(raw);

    return {
      chats: (parsed.chats as McpChatRaw[]).map(toChat),
    };
  }

  async readMessages(params: {
    chat_id: string;
    limit?: number;
    before?: number;
    after?: number;
  }): Promise<{ messages: Message[]; banner: string | null }> {
    const raw = await this.callTool("read_messages", {
      chat_id: params.chat_id,
      ...(params.limit !== undefined && { limit: params.limit }),
      ...(params.before !== undefined && { before: params.before }),
      ...(params.after !== undefined && { after: params.after }),
    });
    const parsed = this.parseToolContent(raw);

    return {
      messages: (parsed.messages as McpMessageRaw[]).map((m) =>
        toMessage(m, params.chat_id)
      ),
      banner: historyBanner(parsed.history as McpHistoryRaw | undefined),
    };
  }

  async sendMessage(params: {
    chat_id: string;
    text: string;
  }): Promise<{ success: boolean; error?: string }> {
    const raw = await this.callTool("send_message", params);
    const parsed = this.parseToolContent(raw) as McpSendResult;
    return {
      success: parsed.success,
      ...(parsed.error && { error: parsed.detail ?? parsed.error }),
    };
  }

  async searchMessages(params: {
    query: string;
    platform?: string;
    chat_id?: string;
    limit?: number;
  }): Promise<{ messages: Message[] }> {
    const raw = await this.callTool("search_messages", params);
    const parsed = this.parseToolContent(raw);

    return {
      messages: (parsed.results as McpSearchResultItem[]).map((r) =>
        toMessage(r.message, r.message.chat_id)
      ),
    };
  }

  async getStatus(): Promise<{ daemon: unknown }> {
    const raw = await this.callTool("get_status", {});
    const parsed = this.parseToolContent(raw);
    return { daemon: parsed };
  }

  async subscribe(uri: string): Promise<void> {
    await this.rawRequest("resources/subscribe", { uri });
  }

  async unsubscribe(uri: string): Promise<void> {
    await this.rawRequest("resources/unsubscribe", { uri });
  }

  async readResource(uri: string): Promise<unknown> {
    const result = await this.rawRequest("resources/read", { uri });
    const contents = result?.result?.contents;
    if (Array.isArray(contents) && contents.length > 0) {
      const text = contents[0].text;
      if (typeof text === "string") return JSON.parse(text);
    }
    return result?.result;
  }

  async openSseStream(): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch("http://localhost/mcp", {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      unix: this.socketPath,
    } as RequestInit);

    if (!res.body) throw new Error("SSE stream: no response body");
    return res.body;
  }

  // --- internal ---

  private async rawRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<any> {
    const id = this.nextId++;
    const body = { jsonrpc: "2.0", id, method, params };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      unix: this.socketPath,
    } as RequestInit);

    if (!this.sessionId) {
      this.sessionId = res.headers.get("mcp-session-id");
    }

    const text = await res.text();
    const parsed = this.parseResponse(text);
    if (parsed?.error) {
      throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
    }
    return parsed;
  }

  private async rawNotification(
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    await fetch("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      unix: this.socketPath,
    } as RequestInit);
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<any> {
    return this.rawRequest("tools/call", { name, arguments: args });
  }

  private parseResponse(text: string): any {
    const dataMatch = text.match(/^data: (.+)$/m);
    if (dataMatch?.[1]) return JSON.parse(dataMatch[1]);
    return JSON.parse(text);
  }

  private parseToolContent(response: any): any {
    const content = response?.result?.content;
    if (Array.isArray(content) && content.length > 0) {
      const text = content[0]?.text;
      if (typeof text === "string") return JSON.parse(text);
    }
    throw new Error(
      `Unexpected MCP tool response: ${JSON.stringify(response)}`
    );
  }
}

export function toChat(raw: McpChatRaw): Chat {
  return {
    id: raw.id,
    name: raw.name,
    platform: raw.platform,
    last_message_time: raw.last_message?.timestamp,
  };
}

/**
 * Banner wording lives here, not in Lua: the same rule as the sticker and retraction
 * placeholders — Lua renders what it is given and never decides how state should read.
 */
const HISTORY_BANNERS: Record<string, string> = {
  unavailable: "── 歷史不可得：此裝置註冊前的訊息 LINE 不下發 ──",
  backfilling: "── 正在補抓歷史… ──",
  partial: "── 更舊的訊息尚未補抓 ──",
};

export function historyBanner(history: McpHistoryRaw | null | undefined): string | null {
  if (!history) return null;
  return HISTORY_BANNERS[history.state] ?? null;
}

export function toMessage(raw: McpMessageRaw, chatId: string): Message {
  const retractedAt = raw.retracted_at ?? null;

  let text: string;
  // Retraction placeholder lives here alongside the sticker/image ones: core clears the
  // content on retraction, so without this Lua would render an empty line.
  if (retractedAt != null) {
    text = "[訊息已收回]";
  } else if (raw.content.type === "text") {
    text = raw.content.text ?? "";
  } else if (raw.content.type === "sticker") {
    const c = raw.content as any;
    text = `[sticker:${c.package_id ?? "?"}/${c.sticker_id ?? "?"}]`;
  } else if (raw.content.type === "image") {
    text = "[image]";
  } else {
    text = `[${raw.content.type}]`;
  }

  return {
    id: raw.id,
    chat_id: raw.chat_id ?? chatId,
    sender_name: raw.sender.display_name,
    text,
    timestamp: raw.timestamp,
    is_self: false, // daemon doesn't expose this yet; will need to compare sender.id with bot user id
    edited_at: raw.edited_at ?? null,
    retracted_at: retractedAt,
  };
}
