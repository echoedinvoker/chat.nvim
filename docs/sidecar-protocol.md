# Sidecar Protocol

JSON lines protocol between Neovim (Lua) and the Bun sidecar process. One JSON object per line, delimited by `\n`.

## Message types

### Request (Lua → Sidecar, via stdin)

```json
{"id": <integer>, "method": "<method_name>", "params": {<method_params>}}
```

- `id`: Non-null integer, used to correlate response. Lua maintains a monotonically increasing counter.
- `method`: One of the supported methods (see below).
- `params`: Method-specific parameters object.

### Response (Sidecar → Lua, via stdout)

```json
{"id": <integer>, "result": <result_data>}
```

or on error:

```json
{"id": <integer>, "error": {"message": "<error_description>"}}
```

- `id`: Matches the request `id`.
- `result`: Method-specific result data (see below).
- `error`: Present instead of `result` on failure.

### Notification (Sidecar → Lua, via stdout)

```json
{"id": null, "method": "<notification_type>", "params": {<notification_data>}}
```

- `id`: Always `null` — distinguishes notifications from responses.
- `method`: Notification type (see below).

## Supported methods (Lua → Sidecar)

| Method | Params | Result | Notes |
|--------|--------|--------|-------|
| `list_chats` | `{platform?, query?, limit?, cursor?}` | `{chats, total, truncated, truncation_banner}` | With no filter and no explicit page, reads the unpaginated `chat://chats` resource so empty chats are not cut off (see below). With any of them, uses the paginated `list_chats` tool. |
| `read_messages` | `{chat_id, limit?, before?, after?}` | `{messages, banner, has_more, oldest_timestamp, older_hint}` | Reads one page. `before`/`after` are epoch ms; `before` means strictly `timestamp < before`. See [Paging fields](#paging-fields). **Side effect**: sidecar auto-subscribes to this chat's messages resource. |
| `send_message` | `{chat_id, text}` | `{success: boolean, error?}` | Sends a text message via chatmux daemon. |
| `search_messages` | `{query, platform?, chat_id?, limit?, offset?}` | `{results: SearchResult[], total}` | FTS5 trigram search, with a LIKE fallback below 3 characters. `chat_id` / `platform` are pushed into SQL, not filtered afterwards. |
| `fetch_media` | `{chat_id, message_id}` | `{path}` or `{unavailable, text}` | One attachment, on demand. `chat_id` is **not** optional — see below. |
| `get_status` | `{}` | `{daemon: StatusObj}` | Returns daemon + adapter connection status. |
| `close_chat` | `{chat_id}` | `{}` | Unsubscribes from chat's messages resource. Lua sends this when user navigates away from a chat. |

### SearchResult object

```typescript
{
  message: Message
  snippet: string       // ⚠️ two shapes, see below
  chat_name: string
}
```

`total` is the full number of hits, counted in SQL — not the length of the returned page.

⚠️ **`snippet` is not always marked up or short.** Above 3 characters the query goes through
FTS5, which returns `…<b>hit</b>…` truncated to 32 tokens. At or below 3 characters — which
is most CJK two-character words — core falls back to `LIKE` and the snippet is the entire
`content_text`, with no `<b>` and possibly newlines. A consumer that assumes markup or
brevity renders a whole paragraph into one row.

The chat and platform filters live in the SQL `WHERE`, in **both** branches. They used to be
applied in JS after an inner `LIMIT 1000`, which silently removed every hit older than the
newest thousand across the whole DB — precisely the case chat-scoped search exists for
(2026-07-31: 3 common single characters exceeded that cap in a 14k-message DB).

### fetch_media

```typescript
{ path: string }                          // bytes are on disk, cached
{ unavailable: string, text: string }     // reason + the wording to show
```

`chat_id` **must** be sent. A Telegram message id names a message only together with its
chat (`chatmux/docs/platform-facts.md` fact 1); without it core matches a different chat's
row and remembers the wrong answer permanently.

Reasons: `gone`, `needs_key`, `unsupported_type`, `timeout`. `timeout` is distinct from
`gone` on purpose — running out of time says nothing about whether the file is still there,
and reporting it as `gone` both misinformed the reader and poisoned core's negative cache
for 24 hours, so the retry that would have worked never happened.

`text` is composed **here**, never in Lua. One origin per piece of copy.

Fetching is slow by nature: measured 2026-07-31, a Telegram refetch runs 14-40s (core
allows its adapter 180s for `get_media`, against 30s for everything else). Callers need a
deadline to match — the Lua RPC layer passes `timeout_sec = 60` for this method alone.

### Chat object

```typescript
{
  id: string            // e.g. "line:Uxxxxx"
  name: string          // Display name
  platform: string      // e.g. "line"
  last_message_time?: number  // Epoch ms of most recent message
}
```

### Message object

```typescript
{
  id: string            // Platform message ID
  chat_id: string
  sender_name: string
  text: string          // Message content; see the placeholder table below
  timestamp: number     // Epoch ms (LINE's createdTime)
  is_self: boolean      // true if sent by the user
  edited_at: number | null      // Non-null once edited in place; text is the current version
  retracted_at: number | null   // Non-null once retracted; text is already a placeholder
  content_type: string          // core's own content.type, passed through
  media?: {                     // present only on image/sticker messages
    state: "ready" | "pending" | "gone"
    path?: string               // local cache path, set only when state is "ready"
  }
}
```

`edited_at` / `retracted_at` come from the daemon (chatmux protocol v0.5) and are what
make a message identifiable as *changed* rather than *new*. A retracted message arrives
with its text already replaced by the placeholder — the sidecar substitutes it, so Lua
never has to decide what a retracted message looks like.

`content_type` exists so Lua can size an inline image without parsing `text`. Inferring
the type from the placeholder wording would make that wording load-bearing, and wording
changes quietly.

#### `media` and the placeholder table

`media.path` is always a local file core has already fetched and cached. Lua never sees a
URL, a header, or a key — which of the three LINE source shapes a message came from is
settled inside the adapter and invisible from here.

Every state's wording is decided in the sidecar, not in Lua. Lua renders what it is given:

| Condition | `media.state` | `text` |
|---|---|---|
| Retracted (wins over everything) | absent | `[訊息已收回]` |
| Cached and ready | `ready` | unchanged (`[sticker:pkg/id]` / `[image]`) |
| Not fetched yet, or the page's 3s budget lapsed | `pending` | `[圖片載入中…]` |
| — any of the above, when the media message also carries text (F44) | unchanged | the caption is appended after the placeholder, one space between: `[image] 今天的貓`. Retraction is the exception: `[訊息已收回]` never gains a caption, because core has cleared the content |
| Deleted on the platform's side | `gone` | `[圖片已不存在於 <平台>]` / `[貼圖已不存在於 <平台>]` — the platform is read off the message's own id, so a Telegram photo says Telegram |
| Not media at all (`video` / `audio` / `file`) | absent | `[video]` etc., unchanged |

The `gone` row is the point of the whole table. A message the platform deleted has to say
so: rendering nothing would be indistinguishable from the plugin being broken, which is
the failure shape this project keeps rediscovering.

`pending` is not an error either. One page resolves its images with at most 4 requests in
flight against a single 3s budget for the whole page; anything still outstanding when the
budget lapses comes back as `pending`. One slow image must never hold a page of text hostage.

**A `pending` image resolves itself (F43).** The stragglers keep being fetched in the
background, and when they land the sidecar pushes one `resource_updated` for that chat
carrying only those messages — the same notification the event tail uses, so Lua's existing
`handle_resource_updated` turns it into one redraw. `state.differs()` compares `media.state`
and `media.path` explicitly, so `pending → ready` is a redraw trigger in its own right.

⚠️ This paragraph used to end "…and fills in on the next redraw", which was wishful: nothing
ever triggered one. A cold page stayed on `[圖片載入中…]` indefinitely and the only thing that
helped was scrolling away and back (second render, local cache). Waiting — the one thing a
user naturally does — was the one thing that could not work. The push is what makes the
sentence true.

The push arrives once the **whole** batch finishes, not progressively, so a page of many
images appears all at once (47 images took 38s in the F43 acceptance run). That is a known
simplification, not a resolved question — see F46 in the project note.

### Paging fields

`read_messages` answers with the page plus everything Lua needs to decide whether there is
a page above it:

```typescript
{
  messages: Message[]              // newest-first, as the daemon returns them
  banner: string | null            // upstream history state, e.g. "更舊的訊息尚未補抓"
  has_more: boolean                // is there anything older in the local DB?
  oldest_timestamp: number | null  // oldest timestamp in *this page*, null if empty
  older_hint: string | null        // the line rendered above the messages
}
```

`has_more` is the daemon's own answer, not a client-side guess: core fetches `limit + 1`
rows and reports whether it had to trim. Inferring it locally ("the page came back full,
so there is probably more") is wrong on the exact-multiple boundary. Anything other than a
literal `true` is read as `false`, so a daemon that omits the field costs at most a missing
hint rather than a request that is guaranteed to come back empty.

**`has_more: false` does not mean "this is the whole conversation."** It means the local DB
is exhausted. Whether the platform still holds older messages is a separate question,
answered by `history.state`, and only `complete` licenses that claim — see
`chatmux/docs/storage-schema.md`. `older_hint` encodes that distinction so the Lua layer
never has to:

| `has_more` | `history.state` | `older_hint` |
|---|---|---|
| `true` | any | `↑ 還有更舊的訊息（按 [ 載入 N 筆）` |
| `false` | `complete` | `── 已是這個聊天室的最開頭 ──` |
| `false` | `unknown` / absent | `── 已載入本機全部；更舊的是否存在未知 ──` |
| `false` | `partial` / `backfilling` / `unavailable` | `null` — `banner` already explains it |

The middle two rows are the point of the table. On a real vault most LINE chats are
`unknown`, so the common case is the one where claiming "this is the beginning" would be a
lie.

The page size in the hint is the size actually requested (`params.limit ?? 20`, matching
core's default in `chatmux/src/core/mcp/tools.ts`). The limit is always sent explicitly so
the number in the hint and the number fetched cannot drift apart.

## Notification types (Sidecar → Lua)

| Method | Params | When |
|--------|--------|------|
| `resource_updated` | `{uri, sidecar_received_at, ...data}` | A subscribed MCP resource changed. Sidecar fetches the data itself and includes it inline (see below). |
| `connected` | `{}` | Sidecar successfully connected to chatmux daemon. |
| `disconnected` | `{reason: string}` | The sidecar process itself exited (emitted by Lua's `sidecar.lua` on process exit, not by the sidecar). **Since F63 the SSE stream ending no longer emits this** — a dead stream is a latency change, not a lost connection. A daemon that is genuinely gone surfaces as `daemon_unreachable` instead, detected by the poll. |
| `reconnecting` | `{}` | The daemon's session is gone (it restarted) and the sidecar is rebuilding: new `initialize`, then every subscription again. A `connected` follows on success. The SSE stream is not reopened here — the supervisor does that on its own next cycle, using the new session id. |
| `sse_degraded` | `{consecutive_failures: number, poll_ms: number}` | The SSE stream failed to reopen `SSE_DEGRADED_AFTER` (3) times in a row. Low-latency push is off; delivery continues via the poll, up to `poll_ms` behind. `poll_ms` is sent rather than assumed because `CHATMUX_POLL_MS` is configurable — a UI that hardcodes 15s would start lying the moment it is changed. |
| `sse_restored` | `{}` | A reopen succeeded after a `sse_degraded`. Only sent if a `sse_degraded` was sent first. |
| `reconnect_failed` | `{attempts: number}` | Recovery gave up after `attempts` tries. The sidecar is still alive and the poll keeps running, so a later attempt can still succeed — but nothing will update until it does. |
| `error` | `{message: string}` | Non-fatal error (e.g. subscription failure). |

#### `resource_updated` payload details

Sidecar fetches the data and transforms it before sending to Lua, so no Lua → sidecar
round-trip is needed. Where that data comes from depends on the URI: the chat list and
status are re-read from their resource, while messages come from the event tail (see
below).

| URI pattern | Extra fields | Example |
|------------|-------------|---------|
| `chat://chats/{id}/messages` | `messages: Message[]`, `msg_timestamp: number` | The messages that changed + the newest one's timestamp. Sourced from the event tail, not the resource — see below. |
| `chat://chats` | `chats: Chat[]`, `total: number`, `truncated: boolean`, `truncation_banner: string \| null` | Updated chat list, same shape as the `list_chats` result |
| Other | Raw resource data | As returned by MCP |

`sidecar_received_at` (epoch ms) is always present — used for latency instrumentation. `msg_timestamp` is only present for messages resources when messages exist.

### Why a messages push follows the event tail

A `chat://chats/{id}/messages` push does **not** come from re-reading that resource. It
comes from `read_events`, core's cursor tail.

The resource answers "what are the newest N messages", and `N` defaults to 20 — it parses
`limit` and nothing else. The buffer holds 50 on open and grows past 160 as the user pages
back with `[`. So an edit or a retraction to anything but the most recent handful changed
in core, notified over SSE, and then never reached the screen, **with nothing to show that
it had not**. Every fix for edits and retractions was verified against a change that had
just happened, which is always inside the window, so the hole survived three rounds of
acceptance.

The tail has no window. A message that is edited or retracted re-enters the sequence at its
end, so a consumer parked anywhere behind still receives it, and the cost is proportional
to what changed rather than to how far back the user has paged.

The payload shape is unchanged — `{uri, messages, sidecar_received_at}`, the same shape the
initial load produces — because the tail returns whole message states, not diffs. Lua
upserts by id and does not care whether a batch is "the newest N" or "the three that
changed". One push per chat, since the tail is global and carries chats this Neovim has
never opened; those are dropped from delivery while the cursor still advances past them.

A tail push carries **no `banner` key**, which is a statement about scope, not a value: the
tail knows what changed, not what a chat's history state is. See `ui-conventions.md` for
why an absent key must not be read as "no banner".

#### The cursor

`read_events` takes a cursor and returns the events after it. The rules the sidecar has to
respect:

- **It is opaque.** Hand it back exactly as received. Never parse it, never compare two of
  them, never do arithmetic on one. "Am I behind?" is answered by `has_more`; "is my cursor
  still valid?" by an `invalid_cursor` error. The one exception — detecting that the log
  shrank underneath us — lives in a single named function so that it stays visible.
- **It is persisted**, at
  `${CHATMUX_DATA_DIR:-~/.local/share/chatmux}/consumers/chat-nvim/cursor.json`, written
  to a temp file and renamed. A half-written cursor file is worse than no cursor file. The
  path follows core's convention for consumers; chat.nvim is one consumer among others and
  owns only its own file.
- **It survives restarts**, which is the point: changes made while Neovim was closed are
  delivered on the next connect instead of being lost.
- **It recovers rather than stalls.** No stored cursor, an unreadable file, an
  `invalid_cursor`, or a cursor ahead of `head_cursor` (SQLite rebuilt or truncated) all
  resolve the same way: start from the current head and log one line. That deliberately
  **skips whatever was missed** — replaying an unknown amount of history to a live buffer is
  worse than a gap, and the gap is bounded by how long the anomaly lasted.

#### Subscription is a latency hint, not the delivery mechanism

The cursor loop is what makes delivery correct. A consumer built purely on
`notifications/resources/updated` loses events whenever it is not connected, and an SSE
stream that dies quietly stops the buffer updating with no signal — the same failure this
whole path exists to remove, wearing a different hat.

So the sidecar polls the tail on a timer (15s, `CHATMUX_POLL_MS`) **and** drains early when
an SSE notification arrives. Never the reverse. Both triggers funnel through one guard so
two drains cannot overlap; a trigger that lands mid-drain schedules one more pass instead of
re-entering.

### Why the chat list has two paths

The `list_chats` tool defaults to `limit: 50` and the daemon sorts `last_message_at DESC
NULLS LAST`, so chats that have never received a message sort last and fall off the end.
On a real vault that hid every empty chat permanently — including the ones the on-demand
backfill and the "history unavailable" banner exist to serve.

An unfiltered request therefore reads `chat://chats`, which the subscription path already
read. Before, opening the list gave 50 chats while any pushed update replaced it with all
of them; both now go through the same builder and answer the same shape.

`chat://chats` still caps at a hard-coded 1000 on the daemon side, so the payload's `total`
is compared against what actually arrived. A short list sets `truncated` and carries a
`truncation_banner` for the UI to show. `truncation_banner` is `null` when nothing was cut
— Lua must pass it through `state.norm()`, since JSON `null` decodes to `vim.NIL`, which is
truthy.

## Sidecar as MCP client

The sidecar is a standard MCP Streamable HTTP client connecting over unix socket.

### Connection flow

1. HTTP POST to `http://localhost/mcp` with `unix` socket option (`$CHATMUX_SOCKET`)
2. MCP `initialize` request → receive session ID from `mcp-session-id` response header
3. Send `notifications/initialized`
4. Open SSE stream: HTTP GET with `Accept: text/event-stream` + session ID header
5. SSE stream delivers `notifications/resources/updated` events

### Subscription management

**Startup subscriptions**: After MCP handshake, sidecar subscribes to:
- `chat://chats` (chat list changes)
- `chat://status` (daemon/adapter status)

**Dynamic subscriptions**: When sidecar processes a `read_messages` request, it checks `subscribedUris: Set<string>`. If the chat's messages URI is not yet subscribed, it calls MCP `resources/subscribe` for `chat://chats/{chat_id}/messages`.

**Unsubscribe**: On `close_chat` from Lua, sidecar calls MCP `resources/unsubscribe` and removes from set.

**Fallback (no longer a working fallback)**: if the daemon errors on `resources/subscribe`, the sidecar logs `subscribe failed … falling back to passive mode`, adds the URI to `subscribedUris` anyway, and carries on filtering SSE notifications client-side. That was survivable only while the daemon broadcast every update to every session, which it did until 2026-08-01. It now sends `notifications/resources/updated` **only to the sessions that subscribed to that URI**, so a session whose subscribe failed receives nothing and "passive mode" delivers no messages at all — it just fails quietly instead of loudly.

Against the current daemon the branch is unreachable (subscribe succeeds; the log line stopped appearing after chatmux `0fbf0f7`). It matters if you point the sidecar at an older daemon, and it is the reason the log line existed for so long without anyone noticing it was a real failure: the thing it warned about was being papered over by the broadcast.

### SSE event handling

```
SSE data line → JSON parse → check method
  → "notifications/resources/updated"
    → extract uri from params
    → if uri not in subscribedUris: ignore
    → if uri matches chat://chats/{id}/messages: drain the event tail
    → else (chat://chats, chat://status): fetch resource, emit stdout notification
```

The split is deliberate. Core notifies `chat://chats` on every change too, and that
resource is the chat list's only update source — its ordering, unread hints and
`last_message` preview all come from there. Routing it through the tail would freeze the
list, which is the same bug in a different place.

A timer drains the same tail every `CHATMUX_POLL_MS` (15s by default) regardless of SSE (see
above), so SSE going quiet costs latency, not correctness.

## Error handling

- **JSON parse failure on stdin**: Log to stderr, skip the line, do not crash.
- **MCP request failure**: Return `{"id": N, "error": {"message": "..."}}` to Lua.
- **SSE stream ends or throws**: reopened by the supervisor (`runSseSupervisor`), which owns the
  stream's whole lifetime — one loop, started once from `index.ts`. A stream that *ended* was
  open, so the next attempt is immediate; a stream that could not be *opened* backs off
  (0, 1s, 2s, 4s… capped at 15s, because a reopen slower than the poll underneath it would make
  the fast path slower than its own floor). No notification either way until three consecutive
  open failures, which emits `sse_degraded`; the next success emits `sse_restored`.
  **It never emits `disconnected`.** The stream is a latency hint on top of the poll, so losing
  it means slower, not gone.
- **Daemon actually gone**: detected by the poll, never by the stream — a reopen against a dead
  daemon just fails and backs off, it does not classify the outage. `isDaemonUnreachable` in the
  drain's catch is the only detector, and it emits `daemon_unreachable`.
- **Daemon restarted (session gone)**: the poll is the detector, not SSE. Its next tick gets
  `-32000 Session not found`, which triggers `initialize` → resubscribe every uri, announced as
  `reconnecting` and then `connected`. The stream is *not* reopened here: the supervisor is
  already looping and picks up the new session id on its next cycle, whereas opening one here
  too would leave two streams running against the same session. The event cursor is kept: core
  encodes it as a SQLite `messages.seq`, so it survives the restart.
- **Socket not found**: Emit `error` notification with clear message, exit with non-zero code.
