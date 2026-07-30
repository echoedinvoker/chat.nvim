import type { McpClient } from "./mcp-client.ts";
import { toChatList, toMessage } from "./mcp-client.ts";
import type {
  ChatmuxEvent,
  McpChatRaw,
  McpMessageRaw,
  MediaResult,
} from "./types.ts";
import { CursorStore, defaultCursorPath } from "./cursor-store.ts";

export type NotificationHandler = (
  method: string,
  params: Record<string, unknown>
) => void;

/** `chat://chats/{id}/messages` — the only uri family that goes through the event tail. */
const MESSAGES_URI = /^chat:\/\/chats\/(.+)\/messages$/;

/**
 * A drain that never ends would peg the sidecar, so the loop is bounded. Hitting the cap
 * is not an error: the cursor has advanced, so the next trigger resumes from there.
 */
const MAX_DRAIN_ROUNDS = 20;

/**
 * Compares two cursors. This is the ONE place allowed to look inside the token, and only
 * to detect the log-shrank case — a consumer must otherwise treat cursors as opaque. Kept
 * in a single named function so the exception stays visible.
 */
function isAhead(cursor: string, headCursor: string): boolean {
  const seq = (c: string) => Number(c.replace(/^evt:/, ""));
  const a = seq(cursor);
  const b = seq(headCursor);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

export class SubscriptionManager {
  private client: McpClient;
  private subscribedUris = new Set<string>();
  private onNotify: NotificationHandler;
  private fallbackMode = false;
  /** Opaque. Passed back verbatim; never parsed, compared by size, or incremented. */
  private cursor: string | null = null;
  private cursorStore: CursorStore;
  private draining = false;
  /** A trigger arrived while a drain was in flight; run one more pass instead of nesting. */
  private drainAgain = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    client: McpClient,
    onNotify: NotificationHandler,
    opts: { cursorPath?: string } = {},
  ) {
    this.client = client;
    this.onNotify = onNotify;
    this.cursorStore = new CursorStore(opts.cursorPath ?? defaultCursorPath());
  }

  async subscribeDefaults(): Promise<void> {
    await this.subscribe("chat://chats");
    await this.subscribe("chat://status");
  }

  async subscribeChat(chatId: string): Promise<void> {
    const uri = `chat://chats/${chatId}/messages`;
    await this.subscribe(uri);
  }

  async unsubscribeChat(chatId: string): Promise<void> {
    const uri = `chat://chats/${chatId}/messages`;
    if (!this.subscribedUris.has(uri)) return;

    try {
      await this.client.unsubscribe(uri);
    } catch {
      // best-effort
    }
    this.subscribedUris.delete(uri);
  }

  async startSseLoop(): Promise<void> {
    const stream = await this.client.openSseStream();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6);
          try {
            const msg = JSON.parse(json);
            await this.handleSseMessage(msg);
          } catch {
            // skip unparseable SSE data
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    this.onNotify("disconnected", { reason: "SSE stream ended" });
  }

  private async handleSseMessage(msg: any): Promise<void> {
    if (msg.method !== "notifications/resources/updated") return;

    const uri = msg.params?.uri;
    if (typeof uri !== "string") return;

    if (!this.subscribedUris.has(uri)) return;

    // Three-way split, deliberately. A `.../messages` notification says "something in
    // some chat changed" — the resource behind it only shows the newest 20, so anything
    // further back changes without ever reaching the buffer (F9). The event tail answers
    // *what* changed regardless of position, so that branch reads it instead.
    //
    // `chat://chats` and `chat://status` must NOT be routed through the tail: core
    // notifies chat://chats on every change too, and it is the chat list's only update
    // source (last_message preview, unopened-chat hint, ordering). Redirecting it would
    // freeze the list — F9 replayed somewhere else.
    if (MESSAGES_URI.test(uri)) {
      await this.drainGuarded();
      return;
    }

    const sidecar_received_at = Date.now();

    try {
      const data = await this.client.readResource(uri);
      const transformed = this.transformResourceData(uri, data);
      this.onNotify("resource_updated", {
        uri,
        sidecar_received_at,
        ...transformed,
      });
    } catch {
      this.onNotify("resource_updated", { uri, sidecar_received_at });
    }
  }

  /**
   * The safety poll. The cursor loop is what makes delivery correct; the subscription is
   * only a latency hint — never the reverse. An SSE stream that dies quietly would
   * otherwise stop the buffer updating with no signal, which is F9 wearing a new hat.
   *
   * The timer only calls `_test_pollOnce`; everything worth testing lives there, so no
   * test has to wait on a real interval.
   */
  startPollLoop(): void {
    if (this.pollTimer != null) return;
    const ms = Number(process.env.CHATMUX_POLL_MS ?? 15_000);
    this.pollTimer = setInterval(() => {
      void this._test_pollOnce();
    }, ms);
  }

  stopPollLoop(): void {
    if (this.pollTimer == null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** One poll tick. Named for the seam it is: a test hook, not public API. */
  async _test_pollOnce(): Promise<void> {
    await this.drainGuarded();
  }

  /**
   * Both triggers — SSE and the poll — funnel through here so two drains never overlap:
   * concurrent drains are what would scramble the cursor.
   *
   * A trigger that arrives mid-drain does not re-enter; it raises `drainAgain` instead, and
   * the current drain runs once more on the way out. Without that second flag, a change
   * landing on the final page would wait for the next poll tick (up to 15s) because its own
   * SSE trigger was swallowed.
   *
   * R14: both flags reset in `finally`. Reset them only on success and one transient
   * failure wedges both paths forever, silently — worse than the bug this fixes.
   */
  private async drainGuarded(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }

    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        await this.drainEvents();
      } while (this.drainAgain);
    } catch (err) {
      // The cursor has not advanced past whatever failed, so the next trigger retries it.
      console.error("[sidecar] event tail drain failed, retrying next trigger:", err);
    } finally {
      this.draining = false;
      this.drainAgain = false;
    }
  }

  /**
   * Read everything that changed after our cursor and push it, grouped per chat.
   *
   * The cursor advances only after every group has been pushed. Advancing first would
   * turn the reference consumer's guarantee ("no gap, at most one duplicate on retry")
   * into "possibly a permanent gap" — and a gap is exactly what F9 is. A duplicate costs
   * nothing here: Lua upserts by message id, so re-applying the same state is a no-op.
   */
  private async drainEvents(): Promise<void> {
    if (this.cursor == null) {
      this.cursor = await this.bootstrapCursor();
    }

    for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
      const since = this.cursor!;
      const page = await this.client.readEvents({ since });

      if ("error" in page) {
        // The stored token was not issued by this core — a different data dir, or a format
        // change. Resyncing from head loses backlog but beats stalling forever, and the
        // bad cursor is never retried.
        console.error(`[sidecar] ${page.error}: ${page.detail} — resyncing from head`);
        this.cursor = await this.headCursor();
        return;
      }

      // Our cursor is past the end of the log: SQLite was rebuilt or truncated under us.
      if (page.events.length === 0 && isAhead(since, page.head_cursor)) {
        console.error(
          `[sidecar] cursor ${since} is ahead of head ${page.head_cursor} — log shrank, resyncing`,
        );
        this.cursor = page.head_cursor;
        this.cursorStore.save(page.head_cursor);
        return;
      }

      await this.pushEvents(page.events);

      this.cursor = page.next_cursor;
      this.cursorStore.save(page.next_cursor);

      if (!page.has_more) return;

      // The cursor is opaque, so "are we making progress?" can only be asked as "did it
      // change?" — never as a comparison. Standing still while has_more stays true means
      // core and we disagree about where the tail is; looping on that is an infinite loop.
      if (page.next_cursor === since) {
        console.error(
          `[sidecar] event tail stalled at ${since} with has_more set — giving up this round`,
        );
        return;
      }
    }

    // Reached only by a tail that keeps producing: log it rather than stopping silently,
    // since the next trigger (SSE or poll) picks up where this left off.
    console.error(
      `[sidecar] event tail still behind after ${MAX_DRAIN_ROUNDS} rounds, continuing next tick`,
    );
  }

  /**
   * Where to start tailing. A stored cursor means "resume, so nothing that happened while
   * we were down is lost"; no stored cursor means start from the current head, which
   * `read_events({})` returns without replaying history.
   */
  private async bootstrapCursor(): Promise<string> {
    const stored = this.cursorStore.load();
    if (stored != null) return stored;
    return this.headCursor();
  }

  /**
   * "Start from now." Omitting `since` is core's way of saying that: it returns the current
   * head and no events, so a consumer begins tailing without replaying history. Used both
   * on first run and to recover from a cursor core does not recognise — which is why it
   * ignores the stored file rather than going through `bootstrapCursor`.
   */
  private async headCursor(): Promise<string> {
    const page = await this.client.readEvents({});
    if ("error" in page) throw new Error(`read_events head failed: ${page.detail}`);
    this.cursorStore.save(page.next_cursor);
    return page.next_cursor;
  }

  /**
   * The tail is global, so it is regrouped per chat before delivery: Lua's
   * `handle_resource_updated` dispatches on uri, and one push per chat keeps the payload
   * shape identical to the initial load's ({uri, messages, sidecar_received_at}).
   */
  private async pushEvents(events: ChatmuxEvent[]): Promise<void> {
    // R15: without this, an edited photo arrives with no media and toMessage renders
    // "[圖片載入中…]" — a placeholder that never resolves, because the next push carries
    // no media either. Retracted rows are skipped: core has already cleared the content,
    // and toMessage gives them no media state, so a lookup would be wasted.
    const mediaRows = events
      .map((e) => e.message)
      .filter((m) =>
        (m.content.type === "image" || m.content.type === "sticker") &&
        m.retracted_at == null);
    const media = mediaRows.length > 0
      ? await this.client.resolveMedia(mediaRows)
      : new Map<string, MediaResult>();

    const byChat = new Map<string, McpMessageRaw[]>();
    for (const event of events) {
      const chatId = event.message.chat_id;
      const rows = byChat.get(chatId);
      if (rows) rows.push(event.message);
      else byChat.set(chatId, [event.message]);
    }

    for (const [chatId, rows] of byChat) {
      // The tail is global: it carries every chat core has, including ones this Neovim
      // has never opened. Pushing those would make Lua allocate state for chats the user
      // cannot see. The cursor still advances past them (see drainEvents) — dropping the
      // payload is not the same as not having read the event.
      const uri = `chat://chats/${chatId}/messages`;
      if (!this.subscribedUris.has(uri)) continue;

      const messages = rows.map((m) => toMessage(m, chatId, media.get(m.id)));
      // Same computation the resource path uses, kept because msg_timestamp feeds the
      // latency instrumentation in Lua's log_latency() — dropping it here would halve
      // that measurement with no error to show for it.
      const latest = messages.reduce((max, m) => (m.timestamp > max ? m.timestamp : max), 0);
      // No `banner` on purpose: the tail knows what changed, not what the chat's history
      // state is. Lua treats an absent banner key as "leave it alone" (see
      // docs/ui-conventions.md) — an empty value would clear F34's history line instead.
      this.onNotify("resource_updated", {
        uri,
        sidecar_received_at: Date.now(),
        messages,
        ...(latest > 0 && { msg_timestamp: latest }),
      });
    }
  }

  private transformResourceData(uri: string, data: unknown): Record<string, unknown> {
    if (typeof data !== "object" || data === null) return data as any;
    const obj = data as Record<string, unknown>;

    // No `.../messages` branch here any more: since F9 those notifications go through the
    // event tail (see handleSseMessage), which reads what changed rather than the newest
    // page. The initial load and `[` still build messages, but via readMessages — the tool,
    // not the resource — so nothing else was left pointing here.

    // chat://chats → same builder the initial load uses, so a push and an open answer
    // the same shape. toChatList defends against a missing/malformed `chats`, so a bad
    // push normalises to an empty list rather than reaching Lua raw.
    if (uri === "chat://chats") {
      return toChatList(obj as { chats?: McpChatRaw[]; total?: number });
    }

    return obj;
  }

  private async subscribe(uri: string): Promise<void> {
    if (this.subscribedUris.has(uri)) return;

    try {
      await this.client.subscribe(uri);
      this.subscribedUris.add(uri);
    } catch {
      if (!this.fallbackMode) {
        console.error(
          `[sidecar] subscribe failed for ${uri}, falling back to passive mode`
        );
        this.fallbackMode = true;
      }
      this.subscribedUris.add(uri);
    }
  }
}
