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

  /**
   * Where a page's late-arriving images go (F43). Set by index.ts to the same notification
   * emitter the event tail uses, so a late image reaches Lua through the one redraw path
   * that F9/F34/F35 already cover — rather than a second, untested delivery route.
   */
  private lateMediaHandler?: (method: string, params: Record<string, unknown>) => void;

  setLateMediaHandler(
    handler: (method: string, params: Record<string, unknown>) => void,
  ): void {
    this.lateMediaHandler = handler;
  }

  async readMessages(params: {
    chat_id: string;
    limit?: number;
    before?: number;
    after?: number;
    /** Injectable page media budget. Production leaves it at 3s; tests pass 0 rather than
     * spending three real seconds proving the snapshot is taken on time. */
    media_deadline_ms?: number;
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
    const media = await this.resolveMedia(
      rows,
      params.chat_id,
      // F43: the images that miss the page budget used to be simply absent, and the comment
      // claiming they would be filled in "on the next redraw" was wishful — nothing
      // triggered one, so a cold page stayed on [圖片載入中…] until the user scrolled away
      // and back. Now the stragglers push one redraw of their own, carrying only themselves.
      (late) => {
        const handler = this.lateMediaHandler;
        if (!handler) return;
        const messages = rows
          .filter((m) => late.has(m.id))
          .map((m) => toMessage(m, params.chat_id, late.get(m.id)));
        if (messages.length === 0) return;
        // Payload shape identical to pushEvents', including the absence of `banner`: Lua
        // reads a missing banner as "leave it alone", while an empty one would wipe F34's
        // history line.
        handler("resource_updated", {
          uri: `chat://chats/${params.chat_id}/messages`,
          sidecar_received_at: Date.now(),
          messages,
        });
      },
      params.media_deadline_ms,
    );

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
   * tail. `resolvePageMediaStreaming` itself stays a free function so it can be tested
   * without a socket (see its own comment); this wrapper exists because `callTool` is
   * private, so a caller outside the client cannot build the `fetchOne` it needs.
   *
   * F35: 3s is the whole batch's budget, not each image's. Anything still outstanding when
   * it lapses is absent from the returned map, which `toMessage` reads as `pending` — and
   * then (F43) arrives through `onLate` once it does resolve.
   */
  async resolveMedia(
    rows: McpMessageRaw[],
    chatId: string,
    onLate?: (media: Map<string, MediaResult>) => void,
    deadlineMs?: number,
  ): Promise<Map<string, MediaResult>> {
    return resolvePageMediaStreaming(
      rows,
      async (id) =>
        this.parseToolContent(
          // F45: a message id names a message only together with its chat. Without this,
          // core matches whichever row it finds first and can answer with — or permanently
          // remember — a different chat's message.
          await this.callTool("get_media", { message_id: id, chat_id: chatId }),
        ),
      {
        deadline: Bun.sleep(deadlineMs ?? 3000),
        ...(onLate ? { onLate } : {}),
      },
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

/** Per-image ceiling. Unrelated to the page's 3s budget: this one only exists so a request
 * that never answers cannot hold a worker slot forever. */
const ITEM_TIMEOUT_MS = 30_000;

/** A timer that resolves to the sentinel and never keeps the process alive by itself. */
function itemTimeout(ms: number): { promise: Promise<typeof TIMED_OUT>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    handle = setTimeout(() => resolve(TIMED_OUT), ms);
    // Nothing should wait on this timer for its own sake — a page that resolved every image
    // in 40ms must not keep the sidecar (or a test runner) up for the remaining 30s.
    (handle as unknown as { unref?: () => void }).unref?.();
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

/**
 * F35/F43: fetches every image on one page, bounded by concurrency, and hands back whatever
 * is ready when the page's deadline lapses — then keeps going in the background.
 *
 * A free function rather than an `McpClient` method on purpose. `callTool` and
 * `rawRequest` are private and the client's only seam is a unix socket path, so a method
 * here could only be tested against a live daemon. Taking `fetchOne` as a parameter moves
 * the part worth testing — the pool, the giving-up, and the late hand-back — into something
 * a test can drive with no socket at all.
 *
 * The deadline is injected for the same reason: the production budget is a wall-clock
 * 3s, but a test that waited 3s to prove a straggler gets dropped would be a test nobody
 * runs. Passing a promise lets the test decide when time is up.
 *
 * F43 is the difference from the F35 version: back then a missed image was simply absent
 * from the map, `toMessage` read that as `pending`, and the comment said it would be filled
 * in "on the next redraw" — which nothing ever triggered. So the first cold page of a chat
 * stayed on `[圖片載入中…]` forever and waiting was the one action that could not help.
 * Now the images that arrive after the snapshot come back through `onLate`, and the caller
 * turns that into exactly one redraw.
 *
 * ⚠️ Contract: every row must belong to the SAME chat. The returned map is keyed on
 * `McpMessageRaw.id`, which is `<platform>:<platform_message_id>` and carries no chat — the
 * very key F45 was about. Telegram restarts message ids per dialog, so feeding this two
 * chats' rows would let one chat's picture be handed to the other's message. A caller with
 * rows from several chats must group first and keep one map per chat, the way
 * `SubscriptionManager.pushEvents` does.
 *
 * Note the two timeouts do different jobs. The page deadline decides *when the user gets a
 * screen*; the per-item timeout decides *when a worker slot is reclaimed*. Racing only the
 * page deadline would drop results that arrive later (F43's whole point); awaiting `fetchOne`
 * bare would let one request that never answers occupy a slot forever, silently starving
 * every image queued behind it.
 */
export async function resolvePageMediaStreaming(
  rows: McpMessageRaw[],
  fetchOne: (id: string) => Promise<MediaResult>,
  opts: {
    concurrency?: number;
    deadline: Promise<unknown>;
    onLate?: (media: Map<string, MediaResult>) => void;
    itemTimeoutMs?: number;
  },
): Promise<Map<string, MediaResult>> {
  const out = new Map<string, MediaResult>();
  const late = new Map<string, MediaResult>();
  const targets = rows.filter(
    (r) => r.content.type === "image" || r.content.type === "sticker",
  );
  const concurrency = opts.concurrency ?? 4;
  const perItemMs = opts.itemTimeoutMs ?? ITEM_TIMEOUT_MS;

  // Flipped once the caller has been handed its page: results after that point can no longer
  // reach the screen through the return value, so they go to `late` instead.
  let snapshotTaken = false;

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const row = targets[next++]!;
      const timer = itemTimeout(perItemMs);
      let result: MediaResult | typeof TIMED_OUT;
      try {
        result = await Promise.race([fetchOne(row.id), timer.promise]);
      } catch {
        // This image failed; the rest of the page has nothing to do with it. Swallowing here
        // rather than at the pool level is what keeps one rejection from ending the batch —
        // and, in the background phase, from becoming an unhandled rejection that would take
        // the sidecar down with it.
        continue;
      } finally {
        timer.cancel();
      }
      if (result === TIMED_OUT) continue;
      (snapshotTaken ? late : out).set(row.id, result as MediaResult);
    }
  };

  const all = Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker),
  );

  await Promise.race([all, opts.deadline]);
  snapshotTaken = true;
  const snapshot = new Map(out);

  // Deliberately not awaited: the caller gets its page now, and the stragglers announce
  // themselves later. `void` so a rejection here can never surface as unhandled.
  void all.then(() => {
    if (late.size > 0) opts.onLate?.(late);
  });

  return snapshot;
}

const TIMED_OUT = Symbol("media-deadline");

// Message ids are "<platform>:<id>". Only the platforms with a conventional
// capitalisation are spelled out; anything else is shown as-is, which is wrong
// in a small way rather than wrong in a misleading way.
const PLATFORM_LABELS: Record<string, string> = {
  line: "LINE",
  telegram: "Telegram",
};

function platformLabel(messageId: string): string {
  const platform = messageId.split(":")[0] ?? "";
  return PLATFORM_LABELS[platform] ?? platform;
}

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
    // R3: a message the platform deleted must say so. Rendering nothing would be
    // indistinguishable from the plugin being broken — the exact failure shape F33 was.
    // Name the platform the message actually came from: telling someone their Telegram
    // photo is gone from LINE reads as a bug in the plugin, not as an explanation.
    const label = platformLabel(raw.id);
    text = raw.content.type === "sticker"
      ? `[貼圖已不存在於 ${label}]`
      : `[圖片已不存在於 ${label}]`;
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

  // A photo's caption is part of what was said, so it belongs next to the placeholder rather
  // than being dropped. No branch above read it: before F40.2 a media message could not carry
  // text at all, so there was nothing to read. Retraction is the one exception — core clears
  // the content, and "[訊息已收回] <caption>" would be showing what was withdrawn.
  if (retractedAt == null && isMedia) {
    const caption = (raw.content.text ?? "").trim();
    if (caption) text = `${text} ${caption}`;
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
