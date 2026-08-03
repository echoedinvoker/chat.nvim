# UI Conventions

## Buffer model

chat.nvim uses three panels, all `buftype=nofile` (scratch buffers, never saved to disk):

```
┌────────────────┬──────────────────────────────────────┐
│  Chat list     │  Messages                            │
│  (vsplit left) │  (center, filetype=markdown)         │
│                │                                      │
│  Alice [●]     │  ## Alice  14:32                     │
│  Bob           │  hey, are you free tonight?          │
│  Team Chat     │                                      │
│                │  ## Me  14:35                         │
│                │  yeah, what's up?                     │
│                │                                      │
│                │  ┌──────────────────────────────┐     │
│                │  │  compose (floating window)   │     │
│                │  │  > _                         │     │
│                │  └──────────────────────────────┘     │
└────────────────┴──────────────────────────────────────┘
```

### Chat list (left panel)

- Created with `vim.cmd('vnew')`, positioned left, fixed width (~30 chars)
- `buftype=nofile`, `bufhidden=wipe`, `modifiable=false`
- Each line: `chat.name [●]` (● = has unread messages, uses highlight group)
- Unread = `chat.last_message_time > (state.last_read[chat_id] or 0)`
  - `or 0` is required: Lua `number > nil` crashes. First-launch chats have no `last_read` entry.
- Auto-refreshes when `chat://chats` resource is updated
- Shows every chat, including ones with no messages — they sort last and used to be cut
  off by the tool's default limit
- When the list came back shorter than the daemon's own `total`, a trailing warning line
  says so (`DiagnosticWarn`). It goes last: truncation happens at the tail, and the top of
  the list is where the user works. `<CR>` is bounded by `#state.chats`, so landing on that
  line is a safe no-op

### Messages (center panel)

- `buftype=nofile`, `filetype=markdown`, `modifiable=false`
- Each message formatted as Markdown H2:

```markdown
## sender_name  HH:MM
message text here

## sender_name  HH:MM
another message
```

- Stickers: `⟦sticker:pkg/id⟧`
- Images: `⟦image⟧`
- `is_self` messages use sender name "Me"
- Messages sorted chronologically (oldest first). API returns newest-first — reverse on initial load.

### Floating composer

- Triggered by `c` keymap in messages buffer
- `nvim_open_win()` with `relative='editor'`, `border='rounded'`, `title=' compose '`
- Position: bottom-center, width = messages buffer width × 80%, height = 5 lines
- Opens in insert mode (`vim.cmd('startinsert')`)
- `<CR>` (normal mode): send message, close float
- `<Esc>` (normal mode): cancel, close float
- Multi-line input supported

## Keymap table

| Panel | Key | Action |
|-------|-----|--------|
| Chat list | `<CR>` | Open selected chat in messages panel |
| Chat list | `q` | Close all chat.nvim UI |
| Chat list | `R` | Refresh chat list |
| Messages | `c` | Open floating composer |
| Messages | `[` | Load one page of older messages above the current ones |
| Messages | `o` | Fetch the attachment under the cursor and hand it to `vim.ui.open`. Only `video` / `audio` / `file`; native `o` is open-line, which in a `modifiable = false` buffer only ever beeped |
| Messages | `q` | Close messages, return to chat list |
| Messages | `j/k/gg/G` | Native vim motion (free) |
| Messages | `/` | Native vim search (free) |
| Messages | `v + y` | Native visual mode yank (free) |
| Search panel | `<CR>` | Jump to the hit under the cursor, paging backwards until it is loaded |
| Search panel | `q` / `<Esc>` | Close the panel, cursor returns to the messages buffer |
| Composer | `<CR>` | Send message (normal mode) |
| Composer | `<Esc>` | Cancel / close (normal mode) |

All keymaps are **buffer-local** (set with `{buffer = bufnr}`). No global keymaps are created.

## Append without flicker

When new messages arrive via push notification, the reader's position decides what happens.
The two branches are not variations on one another — they run different code paths:

```lua
local cursor = vim.api.nvim_win_get_cursor(win)
local at_bottom = cursor[1] >= vim.api.nvim_buf_line_count(bufnr) - 2

if at_bottom then
  -- Full redraw, not an append. See below for why.
  M.render_full(chat_id)
  return
end

-- Reading history: append the new lines and put the cursor back where it was.
vim.bo[bufnr].modifiable = true
vim.api.nvim_buf_set_lines(bufnr, -1, -1, false, new_lines)
vim.bo[bufnr].modifiable = false
pcall(vim.api.nvim_win_set_cursor, win, cursor)
```

**Appending lines cannot draw a picture (F66).** `image.plan` / `image.apply` have exactly
one call site, inside `render_full`. For as long as the at-bottom branch appended lines of
its own, every pushed image landed as `⟦sticker:…⟧` or `⟦image⟧` text with nothing under
it — nine out of nine media messages across two samples, `media.state` already `ready` and
the file already on disk. It was filed as a sidecar bug for three days, because the symptom
is identical to media that never resolved.

Planning the new message's images locally instead is the obvious repair and is wrong:
`image.apply` clears everything live and draws exactly what it is handed, so passing only
the new specs wipes every picture already on screen. Redrawing from state is the cheaper of
the two, and state already holds the new messages — `init.lua` calls `state.append_messages`
before it calls here.

This gives up append's "only touch the new lines" advantage. That is a deliberate trade:
`render_full` is already what every `changed` push runs, and a picture that is never drawn
is not an optimisation.

Dedup: track message IDs in state. On update, append messages whose `id` is not already
in the list.

## Messages that change after they arrive

**An id you already hold is not necessarily a message you already have.** The daemon
re-sends a message under its original id when it is edited or retracted, so treating a
known id as a duplicate silently discards every such change — this is exactly why edits
were invisible in the buffer before. `state.append_messages` upserts instead: it compares
`text`, `edited_at` and `retracted_at` against the stored copy and returns two lists,
`added` and `changed`.

- `#changed > 0` → `render_full(chat_id, { keep_cursor = true })`, redrawing the buffer
  in place. A changed line can be anywhere, and there is no id → line-range map to patch.
- otherwise `#added > 0` → the append path above.

`render_full` normally parks the cursor at the bottom; `keep_cursor` saves and restores
it so a redraw does not yank a user reading history back down. The restored position is
the *line number* held before the redraw, not the line the content moved to — acceptable
because a change rarely alters line counts above the cursor.

Redrawing the whole buffer on every change is deliberate. A chat holds one page (50) plus
whatever `[` has pulled in, so the redraw stays cheap; a streaming bot editing once per
second means one redraw per second at that size. A chat paged back through thousands of
messages is what would make a precise id → line-range map worth its bookkeeping.

⚠️ JSON `null` decodes to `vim.NIL` in Lua — neither `nil` nor comparable to a number.
Normalize before comparing, or every `retracted_at` comparison reports a change.

### An absent key is not an empty value

A push says nothing about the fields it does not carry. `handle_resource_updated` therefore
recomputes the banner **only when the payload has a `banner` key at all**:

- key absent (`params.banner == nil`) → this push is not about the banner; leave it alone.
- key present with `null` (`vim.NIL`) → "there is no banner"; clear it.
- key present with a string → update as usual.

This is not hypothetical tidiness. Pushes sourced from the event tail carry only the
messages that changed and no banner, while pushes sourced from a resource carry the whole
picture. Recomputing from an absent key wipes the history line at the top of the chat the
first time anyone edits a message — a row vanishes and nothing errors.

The `vim.NIL` distinction above is what makes the two cases separable at all: a real `nil`
is the only way a key can be missing, because a JSON `null` never arrives as one.
`scripts/f9-banner-guard-check.lua` asserts both directions.

## Paging backwards through history

`[` in the messages buffer loads one page (50) of older messages and prepends them. Without
it a chat exists in the UI only as its newest page — older messages are not "further up the
scroll", they are absent.

### The buffer header is 0, 2 or 3 lines

```
banner        state.banners[chat_id]     — upstream history state, may be absent
older_hint    state.older_hint[chat_id]  — paging state, may be absent
              blank line, present if either of the above is
messages…
```

Both lines appear and disappear as paging state changes, which is why the anchoring below
measures the buffer rather than counting prepended messages.

### `preserve_view`, not `keep_cursor`

`keep_cursor` restores the saved cursor position verbatim. That is correct only while a
line number keeps meaning the same content — true for an edit, false for a prepend. After N
lines are inserted above, old line L holds what used to be at L-N, so restoring L lands the
reader somewhere else and the screen visibly jumps.

`render_full(chat_id, { preserve_view = true })` compensates:

```lua
local before = vim.api.nvim_buf_line_count(bufnr)
local view = vim.fn.winsaveview()          -- inside nvim_win_call: it acts on the current window
-- …rebuild the buffer…
local delta = vim.api.nvim_buf_line_count(bufnr) - before
view.lnum, view.topline = view.lnum + delta, view.topline + delta
pcall(vim.fn.winrestview, view)
```

The delta comes from the buffer's line count, **not** from how many messages were added:
the header lines shift the reader too. `topline` is restored alongside `lnum` — moving only
the cursor keeps the right message under the cursor while the viewport slides.

### The paging ladder

`before` is a timestamp, and core filters on a strict `timestamp < before`. Paging with
"the oldest timestamp I hold" therefore skips any message sharing that timestamp that did
not fit in the page — silently, and forever. Real data has such ties (one local vault: 630
tie groups, the largest 22 messages).

| rung | `before` | effect |
|---|---|---|
| 1 (default) | `oldest + 1` | inclusive of the tie; re-fetches messages already held, which `append_messages` drops by id |
| 2 (only after rung 1 adds nothing) | `oldest` | strict; guarantees progress at the cost of the rest of that tie |

Rung 2 exists for one degenerate case: an entire page sharing a single timestamp, where
rung 1 makes no progress and would spin. It runs **at most once** — the retry flag makes a
third request unreachable. Losing a few messages of one tie beats a `[` that never advances.

Rung 1 costs a visible overlap: each page re-fetches the whole boundary tie, so the number
of *new* messages per press is `PAGE_SIZE - tie`, not `PAGE_SIZE - 1`. In a tie-free chat
that reads as +49 per press; in a tie-heavy one it can be +28. A short page is not evidence
of dropped messages.

### State

| table | meaning |
|---|---|
| `state.has_more[chat_id]` | is there anything older in the local DB? `nil` = never asked (a request is allowed), only an explicit `false` blocks one |
| `state.in_flight[chat_id]` | a request is in the air; `[` is a no-op until it lands |
| `state.older_hint[chat_id]` | the header line, worded by the sidecar |

There is deliberately no cached oldest-timestamp: it is
`state.messages[chat_id][1].timestamp`, and a second copy would be a second truth.

`in_flight` is cleared on **every** callback exit, including the error path, and by
`state.reset()`. A stale `true` disables `[` for that chat permanently with no error
anywhere — the hardest failure here to notice.

## Searching the full history

`:ChatSearch {query}` searches the **current chat** through core's `search_messages` (not
the buffer), so a hit older than what is loaded is reachable. `/` is left alone: it remains
native vim search over the loaded text.

Results open in a floating panel. Row 1 is the status line; result *n* lives on row *n+1* —
kept in `_set_results` / `_result_at` rather than as an inline offset, because the offset
written twice is how `<CR>` ends up jumping to the neighbouring hit, which still reads as
"it worked".

`<CR>` calls `messages.load_older` in a loop until the target id appears in
`state.msg_rows`, then parks the cursor on it. Three outcomes, three honest wordings:

| outcome | wording |
|---|---|
| found | panel closes, cursor on the message |
| `state.has_more[chat_id] == false` | "本機已載完這間聊天室，仍未到達該訊息。更舊的訊息是否存在於平台端未知。" |
| 20 pages walked | "已往回載入 20 頁仍未到達該訊息；本機 DB 仍有更舊訊息。" |

The middle one is load-bearing. `has_more == false` is a fact about **this machine's DB**,
not about the platform — the same rule `[` follows. Saying "that message does not exist"
would be inventing a fact about a server nobody asked.

**Why this wording lives in Lua when placeholders live in the sidecar.** The sidecar owns
text that describes *a message* (`⟦圖片載入中…⟧`, `[附件已不存在於 Telegram]` — the brackets
differ on purpose, see F65 in `sidecar-protocol.md`) — it is the
only place that knows the message's state, so a second copy in Lua could only drift. The
panel's progress text describes *a loop the sidecar is not part of*: how many pages this
client has walked, and whether it gave up. Nothing on the other side of the socket knows
that. The precedent is the chat list's truncation warning.

Snippets arrive in two shapes and the panel must assume neither: the FTS branch wraps hits
in `<b>…</b>`, while the LIKE branch (query shorter than 3 characters, which is most CJK
two-character words) hands back the whole `content_text`, unmarked and possibly multi-line.
`_clean_snippet` strips the markup, folds newlines, and truncates with `strcharpart` —
`sub()` on bytes would split a CJK character in half.

## Attachments that are not images

`video` / `audio` / `file` render as their sidecar-given label (`⟦影片⟧` / `⟦語音⟧` /
`⟦檔案⟧`) and are opened on demand with `o`, which fetches the bytes and hands the cached
path to `vim.ui.open`. They deliberately do **not** go through `image.plan`: `image.lua`
is for things that belong on screen, and handing a video's bytes to image.nvim is not a
degraded experience, it is a broken one.

- **Images are not openable with `o`.** They are already visible; an external viewer would
  be a second, worse way to look at the same thing.
- **A per-message in-flight guard mirrors `state.in_flight`.** Without it, holding `o`
  launches the external program once per keypress and the status text overwrites itself.
  Cleared on every exit including the error path — a stale `true` disables `o` for that
  attachment for the rest of the session with nothing on screen to say why.
- **Fetching gets a 60s deadline, not the default 10s.** Measured 2026-07-31: a Telegram
  refetch takes 14-40s and core waits up to 180s on its adapter. Under the default, every
  uncached Telegram attachment reported "附件取得失敗" before the real answer — success and
  honest-unavailable alike — and the only visible symptom was a wrong message.
- **The cursor is resolved by walking up to the nearest header row**, because that is where
  a reader's cursor actually is. Reading only the exact row under the cursor passes every
  header-row test and does nothing in real use.
- **All status is virtual text on the message's own line.** The cmdline ban applies here as
  everywhere.

## Inline images

Stickers and photos render as real images in the message area, via image.nvim on Ghostty's
Kitty graphics protocol. `lua/chat-nvim/ui/image.lua` is the **only** file that touches
image.nvim; everything above it deals in specs (`{ id, path, row, height }`), which is what
makes placement testable without a terminal.

- **Lua never decides wording.** `pending` and `gone` already carry their text from the
  sidecar (see `docs/sidecar-protocol.md`). The same rule as retraction placeholders, for
  the same reason: two places writing the same copy is two places for it to drift.
- **Do not reserve blank lines for an image.** image.nvim reserves the space itself, as
  virtual lines sized from the height it actually rendered at. Adding real blank lines on
  top leaves a second gap under every picture exactly as tall as the picture. The
  temptation to add them comes from assuming virtual lines break `[`'s `preserve_view`
  because they do not count towards the buffer's line delta — they do not need to.
  `topline` and `lnum` are buffer line numbers, so restoring `topline + delta` lands on the
  same content, and virtual lines ride along with the extmark of the line they belong to.
- **Render after the lines are in place.** image.nvim anchors on an extmark keyed by
  `buffer:row:col`; an image placed before `nvim_buf_set_lines` is anchored to rows that
  are about to be replaced.
- **Scrolling to the last buffer line does not bring the last picture on screen (F58).**
  The space under a message is virtual lines, and `nvim_buf_line_count` cannot see them, so
  `nvim_win_set_cursor(win, { count, 0 })` parks the cursor on a line Neovim considers
  visible while the picture below it runs off under the statusline — measured at 74 screen
  rows against a window of 62, of which 60 were filler. Use `nvim_win_text_height()`, which
  counts wrapped lines and existing virt_lines both, and search upwards for the smallest
  topline that still fits.
  Two timings have to give the same answer, because the reservation and the scroll race:
  when `magick` has already returned, `nvim_win_text_height` sees the rows and Neovim would
  have got there on its own; when it has not, the height exists only in the spec and has to
  be added by hand. Handling only the first is handling only the already-cached case.
  The compensation belongs wherever the view ended up, **not** in one branch: a
  `keep_cursor` redraw lands on the last line too, and that is the branch every late-media
  redraw takes. `preserve_view` is the exception — leaving the window alone is that
  branch's entire job, and compensating would undo the anchor `[` just restored.
  Expect a gap under the last picture sometimes. The chosen topline is the smallest one
  that fits, so how close it lands to the bottom depends on the height of whatever sits
  above: text scrolls a row at a time and lands flush, another image moves in blocks of its
  own height and cannot.
- **Clear the previous draw before the next one.** Same reason: a leftover image keeps
  reserving space at a row that now holds different text.
- Heights are fixed per content type (`ui/image.lua`), not derived from the image, so a
  page's layout is known before `magick` has measured anything.
- **Only images and stickers reach `image.plan`.** Video, audio and files take the
  `attachment.lua` route above. When renaming anything in that area (`isMedia` →
  `isImageLike`, for one), do not quietly widen it to attachments.

Pinned against image.nvim's installed source rather than its README, because the two
disagree in ways that matter: `y` is a **0-based buffer row**, `width`/`height` are in
**terminal cells** not pixels, and `with_virtual_padding = true` implies `inline = true`
but not the reverse — passing `inline` alone reserves nothing and lands the image on top
of the text below it.

## Notification strategy

### CRITICAL: No cmdline output

**Never use `vim.notify()`, `nvim_echo()`, or `print()` for any user-facing output.** Multiple messages trigger the "Press ENTER or type command to continue" prompt, which blocks the entire editor.

### Notification channels

| Event | Channel | Details |
|-------|---------|---------|
| New message in **current** chat | Buffer append | Handled by messages.lua append flow |
| Edit / retraction in **current** chat | Buffer redraw | `render_full` with the cursor preserved; retracted text renders as italic `_⟦訊息已收回⟧_` so it reads as absence rather than as something the sender typed. The italics are Lua's; the wording arrives from the sidecar (F65) |
| New message in **other** chat | Chat list update + statusline badge | Update `[●]` marker, increment badge count |
| Connection status change | Statusline | `[daemon offline]` / `[reconnecting]` / `[disconnected]` (connected shows unreads or nothing) |
| Delivery mode change | Statusline + persistent notice | `[polling]` plus a notice naming how far behind messages can now be. Only while the connection is healthy — see "Statusline component" (F63) |
| Send success/failure | Virtual text extmark | Temporary extmark near composer area, auto-clear after 3s |
| Error (daemon not running, etc.) | Virtual text in chat list | Persistent until resolved |

### Statusline component

Expose `require('chat-nvim').statusline()` returning a string:
- `💬 3` — 3 chats with unread messages (based on client-side `last_read` tracking)
- `[daemon offline]` — the poll failed at the socket layer: the daemon process is not there
  (F60). Distinct from `[reconnecting]` because it can last until someone starts it
- `[reconnecting]` — the daemon's session went away (it restarted) and the sidecar is
  rebuilding: new `initialize`, then every subscription again. The SSE stream is not part of
  this any more (F63): its supervisor reopens it independently, on the new session id
- `[disconnected]` — sidecar not connected to daemon
- `[polling]` — the connection is healthy but low-latency push is off: the SSE stream failed
  to reopen three times running, so messages arrive on the poll instead, up to `poll_ms`
  behind (F63). Delivery, not connection
- Empty string — no unreads, connected

The four **connection** states are mutually exclusive: one variable, last write wins, and
their relative order in `statusline()` is readability. Delivery is a second variable
(`state.delivery`), orthogonal to connection, because when the daemon restarts "the daemon is
gone" and "the stream will not reopen" are both true and one variable would let them
overwrite each other by arrival order (F63 decision D).

Where delivery sits **is** a precedence decision: `[polling]` is checked after all three
connection states, so a user whose daemon is down reads `[daemon offline]` — the thing they
can act on — instead of being told push is degraded, which by then is noise.
`scripts/f63-degraded-signal-check.lua` asserts that ordering; moving it is a behaviour
change.

Users integrate this into their own statusline config (lualine, heirline, etc.) — see the
README for copy-pasteable lualine and built-in statusline snippets.

#### Why recovery gets its own state (F53)

`[reconnecting]` is not a milder `[disconnected]`. During recovery the sidecar is alive and
working, and nothing is asked of the user; during `[disconnected]` it has stopped and the
user has to do something. Collapsing them would break the F27 rule that the status line does
not lie in either direction — it would either ask for help that isn't needed, or stay quiet
when it is.

Neither state goes through the cmdline. Recovery is frequent (every `systemctl --user restart
chatmux`, and F28 made config changes require exactly that), so a `vim.notify` here would put
a "Press ENTER" in front of the user on a routine action.

The wording of the give-up message follows F34: it says the sidecar could not reconnect and
asks whether the daemon is running. It does **not** claim the daemon has stopped — the
sidecar cannot see that, and a wrong diagnosis sends the user looking in the wrong place.

#### Being seen is its own guarantee (F55)

A state being correct and a user seeing it were, for a while, two different things here, and
only the first was tested. `statusline()` shows nothing unless it has been wired in, so the
README now carries copy-pasteable snippets for lualine and the built-in statusline. And a
standing condition no longer depends on one buffer existing: `notify.set_persistent_notice`
holds it in the module, puts it on the chat list or — failing that — the messages buffer, and
`chat_list.render()` puts it back after a redraw has replaced every line.

Asserted mechanically in `scripts/f60-offline-signal-check.lua`, including the redraw and the
both-buffers-closed case.

### Virtual text extmarks

Used for transient feedback (send confirmation, errors). Created with `nvim_buf_set_extmark()` with `virt_text` option. Auto-cleared with `vim.defer_fn()` after timeout.

## Client-side unread tracking

chatmux daemon's `list_chats` has no unread count. The `read_receipt` field is "recipient read my message" (opposite direction). chat.nvim tracks unreads locally:

- `state.last_read[chat_id]`: timestamp of newest message when user last opened this chat
- Unread = `(state.last_read[chat_id] or 0) < chat.last_message_time`
- Updated when user opens a chat: `state.last_read[chat_id] = latest_message_timestamp`
- Persisted to `~/.local/share/chat-nvim/read-state.json` (survives Neovim restarts)
- Read on plugin startup, written on each `mark_read()` call
