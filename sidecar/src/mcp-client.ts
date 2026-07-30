import type {
  Chat,
  McpChatRaw,
  McpHistoryRaw,
  McpMessageRaw,
  McpSendResult,
  McpSearchResultItem,
  Message,
  ReadMessagesResult,
  ReadEventsResponse,
  MediaState,
  MediaResult,
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

  /** The whole chat list, via the unpaginated resource. See `shouldUseListAll`. */
  async listAllChats(): Promise<ReturnType<typeof toChatList>> {
    const parsed = await this.readResource("chat://chats");
    return toChatList((parsed ?? {}) as { chats?: McpChatRaw[]; total?: number });
  }

  async readMessages(params: {
    chat_id: string;
    limit?: number;
    before?: number;
    after?: number;
  }): Promise<ReadMessagesResult> {
    // Mirrors core's own `limit ?? 20` (chatmux src/core/mcp/tools.ts:174). Duplicating the
    // number is the lesser evil: olderHint has to name a page size in prose, and reading
    // "按 [ 載入 undefined 筆" is worse than a constant that has to be kept in step. If
    // core's default changes, this changes with it.
    const effectiveLimit = params.limit ?? 20;
    const raw = await this.callTool("read_messages", {
      chat_id: params.chat_id,
      // Sent explicitly rather than left to core's default, so the page size the hint
      // promises and the page size actually requested cannot drift apart.
      limit: effectiveLimit,
      ...(params.before !== undefined && { before: params.before }),
      ...(params.after !== undefined && { after: params.after }),
    });
    const parsed = this.parseToolContent(raw);

    const rows = parsed.messages as McpMessageRaw[];
    const media = await this.resolveMedia(rows);

    return {
      messages: rows.map((m) => toMessage(m, params.chat_id, media.get(m.id))),
      banner: historyBanner(parsed.history as McpHistoryRaw | undefined),
      // Compared against `true` explicitly, so a missing key and an `undefined` both land
      // on false. The conservative direction: losing an "there is older" hint costs a
      // prompt the user never sees, while a spurious one costs a request that is
      // guaranteed to come back empty and a `[` that looks broken.
      has_more: parsed.has_more === true,
      oldest_timestamp:
        typeof parsed.oldest_timestamp === "number" ? parsed.oldest_timestamp : null,
      older_hint: olderHint(
        {
          has_more: parsed.has_more === true,
          state: (parsed.history as McpHistoryRaw | undefined)?.state,
        },
        effectiveLimit,
      ),
    };
  }

  /**
   * The one entrance to media resolution, shared by the initial load and by the event
   * tail. `resolvePageMedia` itself stays a free function so it can be tested without a
   * socket (see its own comment); this wrapper exists because `callTool` is private, so a
   * caller outside the client cannot build the `fetchOne` it needs.
   *
   * F35: 3s is the whole batch's budget, not each image's. Anything still outstanding when
   * it lapses is simply absent from the map, which `toMessage` reads as `pending`.
   */
  async resolveMedia(rows: McpMessageRaw[]): Promise<Map<string, MediaResult>> {
    return resolvePageMedia(
      rows,
      async (id) => this.parseToolContent(await this.callTool("get_media", { message_id: id })),
      { deadline: Bun.sleep(3000) },
    );
  }

  /**
   * The event tail: "what happened after where I stopped?". Unlike `read_messages`, which
   * answers with a window of the newest N, this answers with the changes themselves — an
   * edit or retraction of a message far behind the cursor re-enters at the tail, so a
   * consumer parked anywhere still receives it. That is the whole reason F9's push path
   * reads this instead of the resource snapshot.
   *
   * `since` is omitted rather than passed as undefined: to core, an absent `since` means
   * "start from the current head and return no events", which is how a fresh consumer
   * begins tailing without replaying history.
   */
  async readEvents(params: {
    since?: string;
    limit?: number;
  }): Promise<ReadEventsResponse> {
    const raw = await this.callTool("read_events", {
      ...(params.since !== undefined && { since: params.since }),
      ...(params.limit !== undefined && { limit: params.limit }),
    });
    // Errors (invalid_cursor) come back as data on purpose: the caller resyncs from head,
    // and a throw here would make that indistinguishable from a socket failure.
    return this.parseToolContent(raw) as ReadEventsResponse;
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
 * Builds the chat list payload sent to Lua, from either the `list_chats` tool or the
 * `chat://chats` resource — both answer the same shape, so both go through here.
 *
 * `total` is what the daemon says exists; `chats` is what we were actually handed. When
 * they disagree the list is truncated, and saying so is the whole point: `chat://chats`
 * caps at a hard-coded 1000, so silently rendering a short list would just move F11's
 * lie further out rather than remove it.
 */
export function toChatList(obj: {
  chats?: McpChatRaw[];
  total?: number;
}): {
  chats: Chat[];
  total: number;
  truncated: boolean;
  truncation_banner: string | null;
} {
  const chats = (Array.isArray(obj?.chats) ? obj.chats : []).map(toChat);
  const total = typeof obj?.total === "number" ? obj.total : chats.length;
  const truncated = chats.length < total;

  return {
    chats,
    total,
    truncated,
    truncation_banner: truncated
      ? `── 清單截斷：只顯示 ${chats.length} / ${total} 個聊天室 ──`
      : null,
  };
}

/**
 * A request carrying no filter and no explicit page is asking for the whole list, which
 * the tool cannot give: its limit defaults to 50 and chats with no messages sort last,
 * so they fall off the end permanently. Those requests read the resource instead.
 */
export function shouldUseListAll(params: {
  platform?: string;
  query?: string;
  limit?: number;
  cursor?: number;
}): boolean {
  return !params.platform && !params.query && !params.limit && !params.cursor;
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

/**
 * The line above the oldest loaded message: can the user press `[` for more, and if not,
 * what is honestly known about what lies further back.
 *
 * `has_more` wins over every history state, because it answers a different question —
 * "is there more in the local DB right now" — and that is the one `[` acts on.
 *
 * When there is nothing older locally, the wording turns on who is allowed to claim
 * completeness. Per chatmux docs/storage-schema.md:105-121, none of the backfill states
 * except `complete` licenses telling the user "this is everything". `unknown` (and a
 * missing field) is the common case locally — 40 LINE chats plus 71 with no state at all —
 * so getting it wrong is not pedantry, it is the line the user reads most often.
 *
 * `partial` / `backfilling` / `unavailable` return null on purpose: historyBanner already
 * renders a line for each of those, and two lines saying the same thing reads as a bug.
 */
export function olderHint(
  input: { has_more: boolean; state?: string },
  pageSize: number,
): string | null {
  if (input.has_more) {
    return `↑ 還有更舊的訊息（按 [ 載入 ${pageSize} 筆）`;
  }
  if (input.state === "complete") {
    return "── 已是這個聊天室的最開頭 ──";
  }
  if (input.state === undefined || input.state === "unknown") {
    return "── 已載入本機全部；更舊的是否存在未知 ──";
  }
  return null;
}

/**
 * F35: fetches every image on one page, bounded by concurrency and a shared deadline.
 *
 * A free function rather than an `McpClient` method on purpose. `callTool` and
 * `rawRequest` are private and the client's only seam is a unix socket path, so a method
 * here could only be tested against a live daemon. Taking `fetchOne` as a parameter moves
 * the part worth testing — the pool and the giving-up — into something a test can drive
 * with no socket at all.
 *
 * The deadline is injected for the same reason: the production budget is a wall-clock
 * 3s, but a test that waited 3s to prove a straggler gets dropped would be a test nobody
 * runs. Passing a promise lets the test decide when time is up.
 *
 * A message that misses the deadline is simply absent from the map, and `toMessage` reads
 * that as `pending` — it will be filled in on the next redraw. One slow image must never
 * hold a page of text hostage.
 */
export async function resolvePageMedia(
  rows: McpMessageRaw[],
  fetchOne: (id: string) => Promise<MediaResult>,
  opts: { concurrency?: number; deadline: Promise<unknown> },
): Promise<Map<string, MediaResult>> {
  const out = new Map<string, MediaResult>();
  const targets = rows.filter(
    (r) => r.content.type === "image" || r.content.type === "sticker",
  );
  const concurrency = opts.concurrency ?? 4;
  // Resolves to a sentinel instead of rejecting, so a lapsed deadline is an ordinary
  // "no answer" rather than an error every call site would have to catch.
  const expired = opts.deadline.then(() => TIMED_OUT);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const row = targets[next++]!;
      const result = await Promise.race([fetchOne(row.id), expired]);
      if (result !== TIMED_OUT) out.set(row.id, result as MediaResult);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker),
  );
  return out;
}

const TIMED_OUT = Symbol("media-deadline");

export function toMessage(
  raw: McpMessageRaw,
  chatId: string,
  media?: MediaResult,
): Message {
  const retractedAt = raw.retracted_at ?? null;
  const isMedia = raw.content.type === "image" || raw.content.type === "sticker";
  // Retraction wins over media: core has already cleared the content, so a cached image
  // for a retracted message is a leftover, not something to show.
  const mediaState: MediaState | undefined =
    retractedAt != null || !isMedia
      ? undefined
      : media && "path" in media
        ? { state: "ready", path: media.path }
        : media && "unavailable" in media
          ? { state: "gone" }
          : { state: "pending" };

  let text: string;
  // Retraction placeholder lives here alongside the sticker/image ones: core clears the
  // content on retraction, so without this Lua would render an empty line.
  if (retractedAt != null) {
    text = "[訊息已收回]";
  } else if (mediaState?.state === "gone") {
    // R3: a message LINE deleted must say so. Rendering nothing would be indistinguishable
    // from the plugin being broken — the exact failure shape F33 was.
    text = raw.content.type === "sticker" ? "[貼圖已不存在於 LINE]" : "[圖片已不存在於 LINE]";
  } else if (mediaState?.state === "pending") {
    text = "[圖片載入中…]";
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
    content_type: raw.content.type,
    ...(mediaState ? { media: mediaState } : {}),
  };
}
