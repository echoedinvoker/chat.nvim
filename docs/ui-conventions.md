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

- Stickers: `[sticker:pkg/id]`
- Images: `[image]`
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
| Messages | `q` | Close messages, return to chat list |
| Messages | `j/k/gg/G` | Native vim motion (free) |
| Messages | `/` | Native vim search (free) |
| Messages | `v + y` | Native visual mode yank (free) |
| Composer | `<CR>` | Send message (normal mode) |
| Composer | `<Esc>` | Cancel / close (normal mode) |

All keymaps are **buffer-local** (set with `{buffer = bufnr}`). No global keymaps are created.

## Append without flicker

When new messages arrive via push notification, append to the messages buffer without disrupting the user's reading position:

```lua
-- 1. Save cursor state
local win = vim.fn.bufwinid(buf)
local cursor = vim.api.nvim_win_get_cursor(win)
local at_bottom = cursor[1] >= vim.api.nvim_buf_line_count(buf) - 2

-- 2. Append new lines
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, -1, -1, false, new_lines)
vim.bo[buf].modifiable = false

-- 3. Scroll policy
if at_bottom then
  -- User was at bottom → auto-scroll to show new message
  vim.api.nvim_win_set_cursor(win, { vim.api.nvim_buf_line_count(buf), 0 })
else
  -- User was reading history → restore cursor, don't force scroll
  pcall(vim.api.nvim_win_set_cursor, win, cursor)
end
```

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
- **Clear the previous draw before the next one.** Same reason: a leftover image keeps
  reserving space at a row that now holds different text.
- Heights are fixed per content type (`ui/image.lua`), not derived from the image, so a
  page's layout is known before `magick` has measured anything.

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
| Edit / retraction in **current** chat | Buffer redraw | `render_full` with the cursor preserved; retracted text renders as italic `_[訊息已收回]_` so it reads as absence rather than as something the sender typed |
| New message in **other** chat | Chat list update + statusline badge | Update `[●]` marker, increment badge count |
| Connection status change | Statusline | `[connected]` / `[disconnected]` |
| Send success/failure | Virtual text extmark | Temporary extmark near composer area, auto-clear after 3s |
| Error (daemon not running, etc.) | Virtual text in chat list | Persistent until resolved |

### Statusline component

Expose `require('chat-nvim').statusline()` returning a string:
- `💬 3` — 3 chats with unread messages (based on client-side `last_read` tracking)
- `[disconnected]` — sidecar not connected to daemon
- Empty string — no unreads, connected

Users integrate this into their own statusline config (lualine, heirline, etc.).

### Virtual text extmarks

Used for transient feedback (send confirmation, errors). Created with `nvim_buf_set_extmark()` with `virt_text` option. Auto-cleared with `vim.defer_fn()` after timeout.

## Client-side unread tracking

chatmux daemon's `list_chats` has no unread count. The `read_receipt` field is "recipient read my message" (opposite direction). chat.nvim tracks unreads locally:

- `state.last_read[chat_id]`: timestamp of newest message when user last opened this chat
- Unread = `(state.last_read[chat_id] or 0) < chat.last_message_time`
- Updated when user opens a chat: `state.last_read[chat_id] = latest_message_timestamp`
- Persisted to `~/.local/share/chat-nvim/read-state.json` (survives Neovim restarts)
- Read on plugin startup, written on each `mark_read()` call
