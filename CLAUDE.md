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

chatmux `list_chats` has no unread field. Plugin tracks `last_read_timestamp[chat_id]` locally, persisted to `vim.fn.stdpath("data") .. "/chat-nvim/read-state.json"` (i.e. `~/.local/share/nvim/chat-nvim/` on a default Linux setup).

### Resource subscription

Sidecar subscribes to `chat://chats` and `chat://status` on startup. Dynamically subscribes to `chat://chats/{id}/messages` when `read_messages` is called. Unsubscribes on `close_chat`.

## NEVER

1. NEVER use `vim.notify()`, `nvim_echo()`, or `print()` for user-facing messages — multi-message calls trigger "Press ENTER" prompt. Use virtual text, extmarks, floating windows, or statusline
2. NEVER use MCPHub.nvim — it doesn't support unix socket transport or per-resource subscription
3. ~~NEVER render images/stickers~~ — **overturned by F35 (2026-07)**: images and stickers now render inline via image.nvim. What survives of the rule is narrower and still absolute: NEVER produce placeholder wording in Lua. The sidecar's `toMessage` is the single place that decides it (`⟦image⟧`, `⟦圖片載入中…⟧`, `⟦圖片已不存在於 <平台>⟧`, and since F44 the caption appended to them — the white square brackets are F65 and are part of the wording, not decoration). Lua-side placeholder branches keep turning up: two were deleted on 2026-07-29, a third (`ui/messages.lua`, the retracted-message line) survived until 2026-08-03, and two more in `ui/attachment.lua` are known and left alone because they render to the statusline, where nothing a user typed can appear. Do not revive any of them, and **do not trust a count in this sentence** — the third one was invisible to every hand-written list and only fell out of a grep. Grep before you assume the sidecar is the only origin. What made the third one urgent rather than bookkeeping: it overwrote the sidecar's text on a *message panel line*, so `bun test` was fully green while the screen still showed the old wording
4. NEVER import chatmux internals — sidecar communicates only via MCP over unix socket
5. NEVER use `vim.loop.now()` for latency measurement — it's a monotonic clock with arbitrary epoch, not comparable with `Date.now()`. Use `vim.loop.gettimeofday()` and convert to epoch ms
6. NEVER compare JSON `null` fields with `== nil` in Lua — `vim.json.decode` converts JSON `null` to `vim.NIL` (a userdata sentinel), not Lua `nil`. Use `obj.field == nil or obj.field == vim.NIL` or a helper like `is_notification()`
7. NEVER batch-rewrite the non-ASCII literals in this repo with `perl -i` — `-CSD` turns on UTF-8 I/O layers but leaves the *program text* as bytes unless `use utf8` is also set, so a `⟦` written in the substitution is read as bytes and re-encoded on the way out. On 2026-08-03 that double-encoding put `â¦` into four files, and because the loop kept going it also left the replacement half-applied. Placeholder wording lives in a handful of files; change them one at a time and read the result back

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHATMUX_SOCKET` | `~/.local/share/chatmux/chatmux.sock` | Unix socket path to chatmux daemon |

## Prerequisites

- chatmux daemon must be running (occupies IOSIPAD slot)
- line-tui must be stopped (same slot conflict)
- Neovim 0.10+

## Doc-Sync: code fences are claims, not decoration

When a change lands, the docs get checked along two separate axes. Prose and code fences
fail differently and have to be read differently.

1. **Prose drift** — the document says something untrue. A reader may well catch it: it
   contradicts what they see, and they go look. This is the kind every Doc-Sync so far has
   been catching (F9's `Text only`, F35's `CLAUDE.md:83`, F60's "no sign on screen").
2. **Example-code drift** — a fence contains code that no longer matches the
   implementation. A reader does not catch this, because the failure mode is *copying it*.
   The fence looks authoritative precisely because it is code.

For every fence touching an area you changed, ask the question that ordinary review does
not: **is this the version of the code that some defect already removed?** That is the worst
case, because the fence then actively teaches the bug back in. On 2026-08-03 the Scroll
policy example in `docs/ui-conventions.md` was found to be the pre-F66 append
implementation — the exact code whose removal F66 consisted of. Anyone building on that
example would have reintroduced "pushed images never draw", a symptom that was
misdiagnosed as a sidecar bug for three days the first time.

The same sweep found six more across the chatmux repos, in two shapes worth naming:

- **Copy-and-it-breaks**: `saveAuthToken(token)` when the real signature takes
  `(dataDir, token)`; an import path one directory level short, which fails at load before
  any assertion runs.
- **Documented but never implemented**: an `avatar_url` no adapter ever populated;
  `severity`/`code` fields on a notification that only ever carried `message`; a
  `rate_limited` error string that appears nowhere in the daemon, because the rate limiter
  delays sends instead of rejecting them. Each one invites a consumer to write a branch
  that can never run.

Two rules that follow:

- When a fence and the implementation disagree, **the fence moves**. Making the code match
  the doc is a feature decision, not a documentation fix, and it does not belong in a
  Doc-Sync pass.
- Fix a fence by explaining *why* it is that shape, not just by pasting the correct code.
  A fence with no reason attached is one refactor away from being "corrected" back.

Excluded on purpose: files under `docs/spike-reference/`. Those are dated spike artifacts,
labelled as such below — a snapshot going stale is what a snapshot is for.

## References

- `docs/architecture.md` — Three-layer architecture, component responsibilities, data flow
- `docs/sidecar-protocol.md` — JSON lines message format, MCP client behavior
- `docs/ui-conventions.md` — Buffer model, three panels, keymap, notification strategy
- `docs/testing.md` — TDD approach, integration test requirements
- `docs/spike-reference/` — E2 spike artifacts (sidecar.ts, send.ts, spike.lua)
