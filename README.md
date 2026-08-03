# chat.nvim

Read and reply to your IM chats inside Neovim. A three-panel chat UI (chat list / messages /
floating composer) backed by a Bun sidecar that speaks MCP to a
[chatmux](https://github.com/echoedinvoker/chatmux) daemon.

> **This is not a standalone tool.** chat.nvim is a *consumer* — it renders and sends, but owns no
> platform connection of its own. You must be running a [chatmux](https://github.com/echoedinvoker/chatmux)
> daemon, which is what actually talks to LINE (or, via
> [chatmux-adapter-telegram](https://github.com/echoedinvoker/chatmux-adapter-telegram), Telegram).
> Without a daemon, this plugin has nothing to show.

## Requirements

- **Neovim 0.10+**
- **[Bun](https://bun.sh)** — the sidecar is a Bun process launched by the plugin via `jobstart`. Node is not a substitute.
- **A running [chatmux](https://github.com/echoedinvoker/chatmux) daemon** with at least one connected adapter.

## Install

With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "echoedinvoker/chat.nvim",
  config = function()
    require("chat-nvim").setup()
  end,
}
```

With [packer.nvim](https://github.com/wbthomason/packer.nvim):

```lua
use({
  "echoedinvoker/chat.nvim",
  config = function()
    require("chat-nvim").setup()
  end,
})
```

The sidecar has no runtime dependencies — Bun runs it straight from source, so there is no build
step. (`cd sidecar && bun install` only pulls the dev-time type definitions, if you plan to hack
on it.)

### Configuration

`setup()` takes one option:

```lua
require("chat-nvim").setup({
  -- Unix socket exposed by the chatmux daemon.
  socket_path = vim.env.HOME .. "/.local/share/chatmux/chatmux.sock",
})
```

It defaults to `$CHATMUX_SOCKET`, falling back to the path above.

### Statusline

`require("chat-nvim").statusline()` returns one string, and it is the only place an outage
announces itself — nothing is printed and nothing pops up. Wire it in or you will not know
when the daemon has stopped.

| Returns | Means |
|---|---|
| `💬 3` | three chats have unread messages |
| `[daemon offline]` | the sidecar reached the socket and found nothing listening — the daemon is not running (`systemctl --user start chatmux`) |
| `[reconnecting]` | the daemon restarted and the sidecar is rebuilding its session; nothing is asked of you |
| `[disconnected]` | the sidecar process itself stopped (its own exit, not a stream or socket problem) |
| `[polling]` | connected and still delivering, but low-latency push is off — messages arrive on the poll, up to `CHATMUX_POLL_MS` behind |
| `""` | connected, nothing unread |

**lualine** — note that `sections` replaces lualine's defaults outright instead of merging,
so write back the components you want to keep:

```lua
{
  'nvim-lualine/lualine.nvim',
  opts = {
    sections = {
      lualine_a = { 'mode' },
      lualine_b = { 'branch', 'diff', 'diagnostics' },
      lualine_c = { 'filename' },
      lualine_x = {
        { function() return require('chat-nvim').statusline() end },
        'encoding', 'fileformat', 'filetype',
      },
      lualine_y = { 'progress' },
      lualine_z = { 'location' },
    },
  },
}
```

**Built-in statusline**:

```lua
vim.o.statusline = "%f %h%m%r%= %{v:lua.require'chat-nvim'.statusline()} %l,%c"
```

## Usage

| Command | Action |
|---------|--------|
| `:ChatList` | Open the chat list (starts the sidecar on first use) |
| `:ChatOpen {id}` | Open a chat by ID |
| `:ChatSend {text}` | Send to the currently open chat |
| `:ChatSearch {query}` | Search the current chat's full history; hits open in a floating panel, `<CR>` jumps to one — paging backwards automatically if it is not loaded yet |
| `:ChatClose` | Tear down the UI and stop the sidecar |

Keymaps are **buffer-local** — no global mappings are created.

| Panel | Key | Action |
|-------|-----|--------|
| Chat list | `<CR>` | Open selected chat |
| Chat list | `R` | Refresh |
| Chat list | `q` | Close all chat.nvim UI |
| Messages | `c` | Open the floating composer |
| Messages | `q` | Back to chat list |
| Composer | `<CR>` | Send (normal mode) |
| Composer | `<Esc>` | Cancel |

Inside the messages buffer, `j/k/gg/G`, `/`, and visual-mode yank are just Neovim — nothing is
remapped away from you.

## How it works

```
Neovim (Lua plugin)
  │ jobstart → stdin/stdout, one JSON object per line
  ↓
Bun sidecar (TypeScript)
  │ MCP Streamable HTTP over unix socket
  ↓
chatmux daemon → adapter → LINE / Telegram
```

Messages arrive by push: the sidecar subscribes to the daemon's MCP resources and streams
updates back to Lua, which appends to the buffer without stealing your cursor. Messages that
change after the fact travel the same path — edit one from your phone and the text updates in
place; retract it and it renders as `⟦訊息已收回⟧`. See
[`docs/architecture.md`](docs/architecture.md) and
[`docs/sidecar-protocol.md`](docs/sidecar-protocol.md) for this side of the boundary, and chatmux's
[MCP interface](https://github.com/echoedinvoker/chatmux/blob/main/docs/mcp-interface.md) (the
tools and resources this plugin consumes) or
[adapter protocol](https://github.com/echoedinvoker/chatmux/blob/main/docs/adapter-protocol.md)
(how platforms plug in on the far side) for the other.

## Limitations

- **Images and stickers render inline; other media opens externally.** Video, audio and files
  show as `⟦影片⟧` / `⟦語音⟧` / `⟦檔案⟧`; `o` on one fetches it and hands it to your desktop's
  default application. A terminal is a poor player for any of the three, so it does not try to be.
- **Opening a Telegram attachment takes 15-40 seconds.** The bytes are refetched from the platform
  rather than kept locally, so the first `o` on any attachment has a real wait. The second is
  instant — it is cached. LINE attachments land in about a second.
- **An image-heavy chat shows nothing for a while, then everything at once.** Images that arrive
  late are decoded as a batch and drawn in one pass, so the first screen of a busy chat can sit
  unchanged for tens of seconds — 47 images took about 38 seconds here — and then fill in
  completely. Nothing is stuck; there is simply no progress to see. This is separate from the
  15-40 second wait above, which is about opening one attachment on demand. Worth making
  incremental if you routinely open chats with dozens of unloaded images.
- **Cached files have no extension.** Everything that is not an image is stored as `.bin`, so what
  opens it is decided by content sniffing. That works for common types (mp4, pdf, zip, m4a all
  resolved correctly here) but a viewer that keys on the filename may treat the file as a download
  rather than opening it — Chromium does this with PDFs.
- **No filename, size or duration is shown for attachments.** Neither platform provides them
  through the current pipeline: core does not expose the raw event, `messages` has no `file_name`
  column, and the `attachments` table is unused. This is a data gap, not a display choice.
- **Telegram voice messages are indistinguishable from files.** The adapter classifies them as
  documents, so they show as `⟦檔案⟧` and have no voice-specific UI.
- **Search covers the current chat only.** No cross-chat search; `/` is still native vim search
  over what is loaded.
- **Animated stickers show their static frame.** Enough to recognise which sticker it is, which is
  what the line is for. Reconsider if animated stickers become common in your chats, or if
  someone establishes how an APNG behaves under image.nvim — that spike, not the URL handling, is
  the actual first step.
- **Unread state is client-side.** chatmux has no unread field, so the plugin tracks read
  timestamps locally in `stdpath("data")/chat-nvim/read-state.json`. Read state does not sync with
  your phone.
- **One daemon, one slot.** If you also run `line-tui`, stop it first — both occupy the same LINE
  device slot.
- **A daemon outage announces itself and clears itself.** While the daemon is down the
  statusline reads `[daemon offline]` and the chat list carries a standing notice (F60); the
  buffer going quiet is no longer the only sign. Restart the daemon and the sidecar picks
  itself up on the next poll — the notice disappears on its own, no need to restart Neovim.
  Both the detection and the recovery are the poll's, not the SSE stream's, so how fast the
  display catches up follows `CHATMUX_POLL_MS` (~15s by default).

## Development

```bash
cd sidecar && bun test          # sidecar test suite
cd sidecar && bun run src/index.ts   # run the sidecar standalone (needs a daemon)
```

## ⚠️ Account Risk Warning

chat.nvim itself holds no platform credentials, but the daemon behind it does — and those
connections use **unofficial client libraries** (`@evex/linejs` for LINE; MTProto *user* sessions
for Telegram). Using unofficial APIs may violate those platforms' Terms of Service, and your
account may be restricted, suspended, or permanently banned. **Use at your own risk.** See the
[chatmux](https://github.com/echoedinvoker/chatmux) and
[chatmux-adapter-telegram](https://github.com/echoedinvoker/chatmux-adapter-telegram) READMEs for
the full per-platform disclosure.

## ⚠️ Legal Disclaimer

This software is provided "as is", without warranty of any kind. The author is not responsible for
any consequences of using it, including but not limited to account restrictions, data loss, or
violations of third-party terms of service.

This is a personal tool for personal use. Do not use it for spam, harassment, unauthorized access
to others' messages, or any illegal activity.

## 🔒 Privacy Disclosure

Message content reaches Neovim **in plaintext** and lives in ordinary buffers. That means:

- Anything on screen is subject to your usual Neovim behaviour — swap files, session files,
  `:mksession`, screen sharing, and plugins that read buffer contents.
- chat.nvim writes read state to `stdpath("data")/chat-nvim/read-state.json` (chat IDs and
  timestamps, no message text) and latency samples to `/tmp/chat-nvim-latency.log`.
- The messages themselves are stored by the daemon, not here. See chatmux's privacy disclosure for
  what is on disk and how it is protected.

Do not run this on a shared or untrusted machine.

## License

MIT
