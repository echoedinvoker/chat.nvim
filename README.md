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

Optionally surface the unread count in your statusline:

```lua
require("chat-nvim").statusline()  -- "💬 3", "[disconnected]", or ""
```

## Usage

| Command | Action |
|---------|--------|
| `:ChatList` | Open the chat list (starts the sidecar on first use) |
| `:ChatOpen {id}` | Open a chat by ID |
| `:ChatSend {text}` | Send to the currently open chat |
| `:ChatSearch {query}` | Full-text search; results land in the quickfix list |
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
place; retract it and it renders as `[訊息已收回]`. See
[`docs/architecture.md`](docs/architecture.md) and
[`docs/sidecar-protocol.md`](docs/sidecar-protocol.md) for this side of the boundary, and chatmux's
[MCP interface](https://github.com/echoedinvoker/chatmux/blob/main/docs/mcp-interface.md) (the
tools and resources this plugin consumes) or
[adapter protocol](https://github.com/echoedinvoker/chatmux/blob/main/docs/adapter-protocol.md)
(how platforms plug in on the far side) for the other.

## Limitations

- **Text only.** Images and stickers render as `[image]` / `[sticker:pkg/id]` placeholders. Media
  rendering is deliberately deferred, not forgotten — a terminal is a poor image viewer, and the
  placeholder tells you enough to go look at your phone.
- **Unread state is client-side.** chatmux has no unread field, so the plugin tracks read
  timestamps locally in `stdpath("data")/chat-nvim/read-state.json`. Read state does not sync with
  your phone.
- **One daemon, one slot.** If you also run `line-tui`, stop it first — both occupy the same LINE
  device slot.

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
