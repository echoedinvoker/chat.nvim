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

Redrawing the whole buffer on every change is deliberate. The messages resource returns
at most 20 messages, so the redraw is cheap; a streaming bot editing once per second
means one redraw per second at that size. Raising that limit is what would make a precise
id → line-range map worth its bookkeeping.

⚠️ JSON `null` decodes to `vim.NIL` in Lua — neither `nil` nor comparable to a number.
Normalize before comparing, or every `retracted_at` comparison reports a change.

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
