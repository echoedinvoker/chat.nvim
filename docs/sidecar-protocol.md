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
| `search_messages` | `{query, platform?, chat_id?, limit?}` | `{messages: Message[]}` | FTS5 trigram search. |
| `get_status` | `{}` | `{daemon: StatusObj}` | Returns daemon + adapter connection status. |
| `close_chat` | `{chat_id}` | `{}` | Unsubscribes from chat's messages resource. Lua sends this when user navigates away from a chat. |

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
| Deleted on LINE's side | `gone` | `[圖片已不存在於 LINE]` / `[貼圖已不存在於 LINE]` |
| Not media at all (`video` / `audio` / `file`) | absent | `[video]` etc., unchanged |

The `gone` row is the point of the whole table. A message the platform deleted has to say
so: rendering nothing would be indistinguishable from the plugin being broken, which is
the failure shape this project keeps rediscovering.

`pending` is not an error either. One page resolves its images with at most 4 requests in
flight against a single 3s budget for the whole page; anything still outstanding when the
budget lapses comes back as `pending` and fills in on the next redraw. One slow image
must never hold a page of text hostage.

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
| `disconnected` | `{reason: string}` | Connection to daemon lost. |
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

**Fallback**: If daemon returns error on `resources/subscribe` (not supported), sidecar degrades to passive mode — receives all SSE notifications and filters client-side by URI string matching (E2 spike behavior).

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

A timer drains the same tail every 15s regardless of SSE (see above), so SSE going quiet
costs latency, not correctness.

## Error handling

- **JSON parse failure on stdin**: Log to stderr, skip the line, do not crash.
- **MCP request failure**: Return `{"id": N, "error": {"message": "..."}}` to Lua.
- **SSE stream disconnection**: Emit `disconnected` notification, attempt reconnect.
- **Socket not found**: Emit `error` notification with clear message, exit with non-zero code.
