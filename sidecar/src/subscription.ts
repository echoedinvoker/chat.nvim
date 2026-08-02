import type { McpClient } from "./mcp-client.ts";
import { toChatList, toMessage } from "./mcp-client.ts";
import type {
  ChatmuxEvent,
  McpChatRaw,
  McpMessageRaw,
  MediaResult,
} from "./types.ts";
import { CursorStore, defaultCursorPath } from "./cursor-store.ts";
import { describeError } from "./describe-error.ts";
import {
  isSessionGone,
  isDaemonUnreachable,
  backoffMs,
  MAX_RECONNECT_ATTEMPTS,
} from "./reconnect.ts";
import { sseReopenDelayMs, SSE_DEGRADED_AFTER } from "./sse-supervisor.ts";

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
  /**
   * Whether the user has already been told the daemon is gone. A de-dup latch, not a counter:
   * a real outage produces the identical failure every 15s, and notifying on each one would
   * just replay F53's 960-identical-failures flood under a new method name.
   */
  private daemonUnreachable = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** A recovery is in flight. Two of them would open two sessions and strand the first. */
  private reconnecting = false;
  /** Consecutive failures to *open* a stream. Any success resets it — a threshold, not decay. */
  private sseFailures = 0;
  /** Whether the user has already been told push is off. A latch, like `daemonUnreachable`. */
  private sseDegraded = false;

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

  /**
   * A new session knows nothing about the old one's subscriptions, so every uri has to be
   * asked for again. `subscribe()` early-returns on a uri it already has, which is right for
   * the normal path and wrong here — hence the direct client call. The Set itself is left
   * alone: clearing it would break the membership checks in `pushEvents` and
   * `handleSseMessage` that decide what is worth pushing.
   *
   * The log line is not decoration: F42 read "0 subscribe failures" as success when the
   * sidecar had never reached subscribe at all. This is the evidence that it did.
   */
  async resubscribeAll(): Promise<void> {
    const uris = [...this.subscribedUris];
    this.fallbackMode = false;
    let ok = 0;
    for (const uri of uris) {
      try {
        await this.client.subscribe(uri);
        ok += 1;
      } catch {
        if (!this.fallbackMode) {
          console.error(`[sidecar] resubscribe failed for ${uri}, falling back to passive mode`);
          this.fallbackMode = true;
        }
      }
    }
    console.error(`[sidecar] resubscribed ${ok} uri(s)`);
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

    // Returning is not an error and is deliberately silent: the stream ending means the
    // latency hint went away, not that anything was lost. `runSseSupervisor` reopens it.
    // This used to emit `disconnected` — the lie F63 exists to delete (decision B).
  }

  /**
   * Keeps exactly one SSE stream alive for the life of the process. Started once, from
   * `index.ts`; `recoverSession()` deliberately does NOT open its own, or two streams would
   * run in parallel against the same session (decision A).
   *
   * Not awaited by its caller — like `startPollLoop`, this is background work.
   */
  startSseSupervisor(): void {
    void this.runSseSupervisor({});
  }

  /** Named for the seam it is: a test hook, not public API (cf. `_test_pollOnce`). */
  _test_runSseSupervisor = (
    opts: { maxCycles?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<void> => this.runSseSupervisor(opts);

  /**
   * Open → run until the stream ends or throws → back off → open again, forever.
   *
   * The two outcomes are not symmetric. A stream that *ended* got opened, so the failure
   * count resets and the next open is immediate. A stream that could not be *opened* is
   * what backs off, and three of those in a row (`SSE_DEGRADED_AFTER`) is when the user is
   * finally told — by then it is ~3s of no push, past the point where it could still be one
   * flaky attempt.
   *
   * What it never emits is `disconnected`. Delivery correctness belongs to the poll
   * (`startPollLoop`); this stream is a latency hint, so losing it means "slower", never
   * "gone" (decision B).
   *
   * `maxCycles` and `sleep` exist only for tests: without them a test either waits on real
   * backoff or never returns.
   */
  private async runSseSupervisor(opts: {
    maxCycles?: number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<void> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let cycle = 0; opts.maxCycles == null || cycle < opts.maxCycles; cycle += 1) {
      const wait = sseReopenDelayMs(this.sseFailures);
      if (wait > 0) await sleep(wait);

      const startedAt = Date.now();
      try {
        await this.startSseLoop();
        this.sseFailures = 0;
        if (this.sseDegraded) {
          this.sseDegraded = false;
          console.error("[sidecar] sse reopened");
          this.onNotify("sse_restored", {});
        }
        // The success path has no backoff by design (a clean end must not cost a second),
        // which leaves it with no floor at all: a peer that accepts the stream and closes it
        // immediately would turn this into an unthrottled reopen loop against the daemon —
        // F53's 960-identical-failures flood in a new costume. One reopen per second is
        // slack enough to be free and still 15x faster than the poll underneath it.
        const elapsed = Date.now() - startedAt;
        if (elapsed < 1_000) await sleep(1_000 - elapsed);
      } catch (err) {
        this.sseFailures += 1;
        console.error(
          `[sidecar] sse reopen failed (${this.sseFailures}): ${describeError(err)}`,
        );
        if (this.sseFailures >= SSE_DEGRADED_AFTER && !this.sseDegraded) {
          this.sseDegraded = true;
          // The interval is read here and shipped to Lua rather than hardcoded there: it is
          // configurable, and a UI that says "15s" while the env says otherwise is a new lie
          // in the place F63 just removed one (decision E).
          this.onNotify("sse_degraded", {
            consecutive_failures: this.sseFailures,
            poll_ms: Number(process.env.CHATMUX_POLL_MS ?? 15_000),
          });
        }
      }
    }
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
      // Recovery path ①: the socket simply answers again, session intact. Nothing else in the
      // code would ever lower the latch on this path, and a latch that never falls makes the
      // *second* outage silent.
      this.clearDaemonUnreachable();
    } catch (err) {
      // F53: the poll is the only detector once the daemon dies. Since F63 the SSE stream is
      // reopened by `runSseSupervisor`, but that changes nothing here: a reopen against a dead
      // daemon just fails and backs off, it never classifies the outage. So a dead session
      // still surfaces here and nowhere else, and retrying "next trigger" would retry forever
      // against an id the daemon has never heard of (measured: 960 failures over four hours).
      if (isSessionGone(err)) {
        await this.recoverSession();
        return;
      }
      // F60: the other outage. Ordered after isSessionGone because that one is the recoverable
      // one; the two predicates are proven mutually exclusive (reconnect.test.ts), so the order
      // changes only how this reads, not what it does.
      if (isDaemonUnreachable(err)) {
        if (!this.daemonUnreachable) {
          this.daemonUnreachable = true;
          const { code } = err as { code?: unknown };
          console.error(`[sidecar] daemon unreachable (${String(code)})`);
          this.onNotify("daemon_unreachable", { code: String(code) });
        }
        return;
      }
      // The cursor has not advanced past whatever failed, so the next trigger retries it.
      console.error(
        `[sidecar] event tail drain failed, retrying next trigger: ${describeError(err)}`,
      );
    } finally {
      this.draining = false;
      this.drainAgain = false;
    }
  }

  /**
   * The one place that lowers the latch and says so. Called from the drain-succeeds path;
   * recoverSession lowers it inline instead, because it already sends its own `connected`
   * and two of them would make the Lua side flip state twice for one recovery.
   */
  private clearDaemonUnreachable(): void {
    if (!this.daemonUnreachable) return;
    this.daemonUnreachable = false;
    console.error("[sidecar] daemon reachable again");
    this.onNotify("connected", {});
  }

  /** Named for the seam it is: a test hook, not public API (cf. `_test_pollOnce`). */
  _test_recoverSession = (): Promise<void> => this.recoverSession();

  /**
   * Rebuild everything a new session does not inherit: the session id itself, every
   * subscription, and the SSE stream. The cursor is deliberately left alone — core encodes it
   * as `messages.seq` from SQLite (chatmux src/core/mcp/tools.ts:230), so it stays valid
   * across a daemon restart and re-deriving it would either replay or skip.
   */
  private async recoverSession(): Promise<void> {
    // Check-and-set before any await: `backoffMs(1)` is 0, but its setTimeout still yields,
    // and a guard set after that turns the concurrency test into a scheduling coin flip.
    if (this.reconnecting) return;
    this.reconnecting = true;

    try {
      this.onNotify("reconnecting", {});

      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
        const wait = backoffMs(attempt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        try {
          await this.client.reconnect();
        } catch (err) {
          console.error(
            `[sidecar] reconnect attempt ${attempt} failed: ${describeError(err)}`,
          );
          continue;
        }

        await this.resubscribeAll();
        // No stream is opened here on purpose (decision A). The supervisor is already
        // looping, and `client.reconnect()` has just written the new session id into the
        // client — so the supervisor's *next* open picks it up by itself. Opening one here
        // too would leave two streams running against the same session.
        console.error("[sidecar] reconnected");
        // Recovery path ②: the daemon came back and the session did not survive it. Lower the
        // latch here rather than calling clearDaemonUnreachable() — the `connected` below is
        // already this recovery's one announcement.
        this.daemonUnreachable = false;
        this.onNotify("connected", {});
        return;
      }

      console.error(
        `[sidecar] gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`,
      );
      this.onNotify("reconnect_failed", { attempts: MAX_RECONNECT_ATTEMPTS });
    } finally {
      // R14's reason: resetting only on success wedges recovery forever after one bad run.
      this.reconnecting = false;
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

    // F45: resolved per chat, and kept per chat. The tail is global, so one batch would
    // ask for a message id without saying which chat's message it is — and the map's key
    // is that same chat-less id, so two chats carrying the same id (routine on Telegram,
    // where ids restart per dialog) would silently overwrite one another and hand a chat
    // the other one's picture. Grouping only the media rows, not `byChat` below: that one
    // holds every event including text edits, and feeding it here would send get_media
    // requests for messages that have no media.
    const mediaRowsByChat = new Map<string, McpMessageRaw[]>();
    for (const row of mediaRows) {
      const rows = mediaRowsByChat.get(row.chat_id);
      if (rows) rows.push(row);
      else mediaRowsByChat.set(row.chat_id, [row]);
    }
    const mediaByChat = new Map<string, Map<string, MediaResult>>();
    for (const [chatId, rows] of mediaRowsByChat) {
      mediaByChat.set(chatId, await this.client.resolveMedia(rows, chatId));
    }

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

      const media = mediaByChat.get(chatId);
      const messages = rows.map((m) => toMessage(m, chatId, media?.get(m.id)));
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
    } catch (err) {
      // F54: a subscribe is the other place a dead session surfaces, and falling back to
      // passive mode here treats "the session id is gone" as "this chat cannot be watched" —
      // the sidecar then sits in fallback against a daemon that would happily answer a fresh
      // session. Only a *session* loss escalates: an ordinary "Chat not found" must not tear
      // down a working session (asserted).
      if (isSessionGone(err)) {
        this.subscribedUris.add(uri);
        void this.recoverSession();
        return;
      }
      if (!this.fallbackMode) {
        console.error(
          `[sidecar] subscribe failed for ${uri}, falling back to passive mode`
        );
        this.fallbackMode = true;
      }
      // Deliberate, and it reads like a leak: the uri goes into the set even though the
      // subscribe never took. A reconnect is exactly when a subscription that failed should
      // be tried again, and resubscribeAll() only knows about what is in this set — drop it
      // here and the chat stays silently unsubscribed for the rest of the session.
      // Pinned by "F54 sidenote: a subscribe that failed is still replayed on reconnect".
      this.subscribedUris.add(uri);
    }
  }
}
