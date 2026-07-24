# chat.nvim

Neovim plugin consumer for chatmux — Lua plugin + Bun sidecar over unix socket MCP.

## Commands

- `cd sidecar && bun test` — Run sidecar tests (bun:test)
- `cd sidecar && bun run src/index.ts` — Start sidecar standalone (needs chatmux daemon)
- `echo '{"id":1,"method":"get_status","params":{}}' | bun run sidecar/src/index.ts` — Quick smoke test

## Directory Structure

- `lua/chat-nvim/init.lua` — setup(), user commands registration
- `lua/chat-nvim/sidecar.lua` — jobstart lifecycle, JSON lines parse, pending request tracking
- `lua/chat-nvim/state.lua` — In-memory state (chats, messages, connection, last_read)
- `lua/chat-nvim/keymap.lua` — Buffer-local keybindings
- `lua/chat-nvim/ui/chat_list.lua` — Left panel: chat list buffer
- `lua/chat-nvim/ui/messages.lua` — Center panel: message buffer + append-without-flicker
- `lua/chat-nvim/ui/composer.lua` — Floating composer window
- `lua/chat-nvim/ui/notify.lua` — Virtual text / extmark / statusline notifications
- `plugin/chat-nvim.lua` — lazy.nvim entry point
- `sidecar/src/index.ts` — Entry: stdin parse → dispatch → stdout emit
- `sidecar/src/mcp-client.ts` — MCP Streamable HTTP client over unix socket
- `sidecar/src/subscription.ts` — Resource subscription → stdout notifications
- `sidecar/src/types.ts` — Shared types
- `sidecar/tests/` — bun:test suites (unit + integration)
- `docs/spike-reference/` — E2 spike artifacts (read-only reference)

## Architecture

```
Neovim (Lua plugin)
  │ jobstart(['bun', 'run', 'sidecar/src/index.ts'])
  │ stdin/stdout: JSON lines (request/response/notification)
  ↓
Bun sidecar (TypeScript)
  │ MCP Streamable HTTP (HTTP/1.1 POST + SSE)
  │ over unix socket (~/.local/share/chatmux/chatmux.sock)
  ↓
chatmux daemon
  │ adapter protocol (stdio JSON-RPC)
  ↓
LINE adapter → LINE Messaging API → recipient
```

Two communication boundaries:
1. Lua ↔ sidecar: JSON lines over stdin/stdout (one JSON object per line)
2. Sidecar ↔ daemon: MCP Streamable HTTP over unix socket

## Pattern Selection

### JSON Lines IPC (Lua ↔ Sidecar)

Request/response with integer `id` correlation. Notifications use `id: null`.

```json
// Lua → Sidecar (stdin)
{"id": 1, "method": "list_chats", "params": {}}

// Sidecar → Lua (stdout, response)
{"id": 1, "result": {"chats": [...]}}

// Sidecar → Lua (stdout, notification)
{"id": null, "method": "resource_updated", "params": {"uri": "chat://chats/line:Uxx/messages"}}
```

### Neovim on_stdout buffering

`jobstart` with `stdout_buffered=false` may split a single JSON line across multiple callbacks. Maintain a `partial_line` buffer: last element of `data` array that isn't `""` is partial; prepend it to first element of next callback.

### Client-side unread tracking

chatmux `list_chats` has no unread field. Plugin tracks `last_read_timestamp[chat_id]` locally, persisted to `~/.local/share/chat-nvim/read-state.json`.

### Resource subscription

Sidecar subscribes to `chat://chats` and `chat://status` on startup. Dynamically subscribes to `chat://chats/{id}/messages` when `read_messages` is called. Unsubscribes on `close_chat`.

## NEVER

1. NEVER use `vim.notify()`, `nvim_echo()`, or `print()` for user-facing messages — multi-message calls trigger "Press ENTER" prompt. Use virtual text, extmarks, floating windows, or statusline
2. NEVER use MCPHub.nvim — it doesn't support unix socket transport or per-resource subscription
3. NEVER render images/stickers — use `[sticker:pkg/id]` or `[image]` text placeholders
4. NEVER import chatmux internals — sidecar communicates only via MCP over unix socket
5. NEVER use `vim.loop.now()` for latency measurement — it's a monotonic clock with arbitrary epoch, not comparable with `Date.now()`. Use `vim.loop.gettimeofday()` and convert to epoch ms

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHATMUX_SOCKET` | `~/.local/share/chatmux/chatmux.sock` | Unix socket path to chatmux daemon |

## Prerequisites

- chatmux daemon must be running (occupies IOSIPAD slot)
- line-tui must be stopped (same slot conflict)
- Neovim 0.10+

## References

- `docs/architecture.md` — Three-layer architecture, component responsibilities, data flow
- `docs/sidecar-protocol.md` — JSON lines message format, MCP client behavior
- `docs/ui-conventions.md` — Buffer model, three panels, keymap, notification strategy
- `docs/testing.md` — TDD approach, integration test requirements
- `docs/spike-reference/` — E2 spike artifacts (sidecar.ts, send.ts, spike.lua)
