# Testing

## TDD approach

TDD effort is concentrated on the **Bun sidecar** where it has the highest leverage. Lua plugin code is tested via manual verification + integration tests.

### Why this split

| Layer | Testability | TDD value | Approach |
|-------|------------|-----------|----------|
| **Sidecar (TypeScript)** | High — pure functions, mockable I/O | High — protocol correctness, edge cases | bun:test, TDD |
| **Lua plugin** | Low — requires running Neovim, plenary.nvim setup cost | Low — mostly nvim API glue | Manual `:source` + integration test |

### Sidecar test categories

| File | Category | What it tests | Mock vs Real |
|------|----------|---------------|-------------|
| `tests/protocol.test.ts` | Unit | JSON lines parse/emit, id correlation, error formatting | Mock stdin/stdout |
| `tests/mcp-client.test.ts` | Unit | MCP connection, tool call proxy, session management | Mock socket (or real daemon) |
| `tests/subscription.test.ts` | Unit | Subscribe/unsubscribe lifecycle, fallback to passive mode | Mock MCP server responses |
| `tests/integration.test.ts` | Integration | End-to-end: connect → list → send → verify delivery | **Real daemon required** |

### bun:test conventions

- Test files in `sidecar/tests/`
- Run all: `cd sidecar && bun test`
- Run specific: `cd sidecar && bun test tests/protocol.test.ts`
- Integration tests need chatmux daemon running
- Use `describe` / `it` / `expect` from bun:test
- Async tests: return promise or use async/await

## Integration test: hard requirement

**At least one test must perform a real `send_message` through the full stack** (sidecar → daemon → adapter → LINE API → recipient receives it). This is a project success criterion.

### Why

chatmux v0.1 had 165 passing tests (DC-4), but `send_message` was never tested end-to-end. Three wire-up bugs were only discovered during manual testing after "all tests pass." Mock-only testing creates false confidence.

### What the integration test must do

1. Connect sidecar to running chatmux daemon
2. Call `list_chats` → verify non-empty response
3. Pick a chat (first one, or a specific test chat)
4. Call `send_message` with test payload (include timestamp for identification)
5. Call `read_messages` → verify the sent message appears in results
6. (Manual verification: check recipient phone received the message)

### Running integration tests

```bash
# Prerequisites
# 1. chatmux daemon is running
# 2. LINE adapter is connected
# 3. line-tui is NOT running (IOSIPAD slot conflict)

cd sidecar && bun test tests/integration.test.ts
```

Integration tests are not run in CI (no daemon available). They are run manually during development.

## Mock vs Real boundary

| What | Mock OK | Must be real |
|------|---------|-------------|
| JSON lines parse/emit | ✅ | |
| MCP session management | ✅ | |
| Subscription lifecycle | ✅ | |
| `send_message` delivery | | ✅ (integration test) |
| `list_chats` response format | ✅ (unit) | ✅ (integration, verify real data) |
| Resource update notifications | ✅ (unit) | ✅ (integration, verify SSE works) |
| Socket connection | ✅ (unit) | ✅ (integration) |

## Lua verification

Since Lua plugin code is not TDD'd, verify manually:

1. `:source plugin/chat-nvim.lua` — no errors
2. `:ChatList` — sidecar starts, chat list renders
3. `:ChatOpen <id>` — messages render in markdown format
4. `c` → type → `<CR>` — message sent, recipient receives
5. Send message from phone → buffer auto-appends without flicker
6. `q` — UI closes cleanly, sidecar stops

Check these after any significant Lua change.

## Latency instrumentation

Phase 4 adds timestamp-based latency tracking:
- `msg_timestamp` (LINE's `createdTime`) → `sidecar_received_at` (`Date.now()`) → `lua_rendered_at` (`vim.loop.gettimeofday()`)
- Log to `/tmp/chat-nvim-latency.log`
- Target: p95 full-chain < 2 seconds
- Note: `msg_timestamp` vs `sidecar_received_at` spans machines (possible clock skew). `sidecar_received_at` vs `lua_rendered_at` is local IPC, same machine.
