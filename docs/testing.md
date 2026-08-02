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
3. Address a **fixed** test chat, not `chats[0]`
4. Call `send_message` with test payload (include timestamp for identification)
5. Call `read_messages` → verify the sent message appears in results
6. (Manual verification: check recipient phone received the message)

### The test target is fixed, and overridable

The send test targets `telegram:7869659098` (the author's Telegram Saved Messages), not
whichever chat sorts first. `chats[0]` is ordered by recency, so it drifts between runs and
a *real* send — which this test deliberately performs — can land in someone else's
conversation. Override with `CHATMUX_TEST_CHAT_ID` when running against a different
account:

```bash
CHATMUX_TEST_CHAT_ID=line:uXXXX bun test tests/integration.test.ts
```

If the chat is not in `list_chats`, the test fails with that instruction rather than
silently sending somewhere else.

### Running integration tests

```bash
# Prerequisites
# 1. chatmux daemon is running
# 2. LINE adapter is connected
# 3. line-tui is NOT running (IOSIPAD slot conflict)

cd sidecar && bun test tests/integration.test.ts
```

Integration tests are not run in CI (no daemon available). They are run manually during development.

The delivery test waits by polling with a deadline, not by sleeping a guessed amount. It
sends a marker, then re-reads the chat every 500ms for up to 25 seconds (`tests/support/
wait-for.ts`), and the test's own timeout is 30 seconds so that a failure reports what it
was waiting for rather than bun's information-free "test timed out". A real Telegram round
trip has no predictable upper bound — least of all just after a daemon restart, while the
adapter is still backfilling — so the previous `sleep(500)` then read once could only guess,
and when it guessed low it failed for a reason that had nothing to do with the code under
test (F61).

### Tests allowed to be red

**None. Any red is a real failure.**

Measured 2026-08-02, daemon healthy, `cd sidecar && bun test`: 170 pass, 0 fail across 11
files — integration included.

This section exists because "that one is just flaky" is a category that absorbs real
failures. If a test ever earns a place on this list, it goes here by name, with what its red
looks like and why it is allowed — never as a blanket exemption. An empty list is the
maintained state, not an oversight.

Note that a green suite is not the same as a verified change. Three of the checks under
[Lua verification](#lua-verification) exist because a mechanical assertion passed while the
screen was wrong: `virt_lines_above` on line 0 creates a valid extmark that Neovim never
draws, and the shape-of-the-extmark assertion could not tell the difference. Assert what a
user would see wherever that is possible.

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

### The running sidecar is not the code you just edited

The sidecar is a long-lived Bun process that Neovim starts once. Editing `sidecar/src/`
does **not** hot-reload it: until you close that Neovim and open a new one, the process
still runs the code it was launched with.

This bites hardest when the thing you are verifying is a *detector*. Grepping the log for
a line your new branch is supposed to print and finding zero of them reads as "the branch
did not fire" — but the branch is not in that process at all. The tell is the old path
still logging: if you see the message the code used to print, you are looking at the old
build.

So before any end-to-end run that is meant to exercise sidecar changes:

1. Close the Neovim that owns the sidecar (`pgrep -af "chat.nvim/sidecar"` should go empty)
2. Open a fresh one and re-run `:ChatList`
3. Confirm the new process started *after* your edit:
   `ps -C bun -o pid=,lstart=,cmd= | grep chat.nvim/sidecar` against the file's mtime

Use `ps -C bun` rather than `pgrep -f` for that check: `pgrep -f` matches on the full
command line and will happily match the shell running the `pgrep` itself, so it can report
a PID when no sidecar exists at all.

### Headless assertion scripts

Some Lua behaviour cannot be settled by looking: "the view did not jump" and "the paging
ladder stopped" both look fine for the first second, and a screenshot cannot tell a
correctly anchored buffer from an off-by-delta one. Those get a script under `scripts/`,
run without a daemon by injecting a stub into `package.loaded["chat-nvim.sidecar"]`:

```bash
nvim --headless -l scripts/f34-anchor-check.lua; echo "exit=$?"        # prints OK: 6/6
nvim --headless -l scripts/f35-image-spec-check.lua; echo "exit=$?"    # prints ALL PASS: 16/16
nvim --headless -l scripts/f9-banner-guard-check.lua; echo "exit=$?"   # prints PASS: 3/3
nvim --headless -l scripts/f43-media-redraw-check.lua; echo "exit=$?"  # prints ALL PASS
nvim --headless -l scripts/f36-search-jump-check.lua; echo "exit=$?"   # prints OK: 19/19
nvim --headless -l scripts/f38-attachment-open-check.lua; echo "exit=$?" # prints OK: 11/11
nvim --headless -l scripts/f60-offline-signal-check.lua; echo "exit=$?" # prints PASS: 10/10
nvim --headless -l scripts/f63-degraded-signal-check.lua; echo "exit=$?" # prints ALL PASS
nvim --headless -l scripts/f62-notice-anchor-check.lua; echo "exit=$?"  # prints ALL PASS
bash scripts/f62-notice-onscreen-check.sh; echo "exit=$?"               # prints ALL PASS
```

`f9-banner-guard-check.lua` stubs only the sidecar and sets `state.current_chat = nil`, so
nothing enters the render path: it asserts the banner state machine alone — a push with no
`banner` key leaves the banner untouched, an explicit `null` clears it, a string updates it.
Whether the banner is then *drawn* is a question for a real buffer, not for this script.

`f35-image-spec-check.lua` stubs image.nvim as well as the sidecar: a fake renderer
records the specs it is handed and draws nothing. It asserts placement (each ready image
one row under its header, at the cached path, at the height its content type calls for),
absence (`pending` / `gone` / `video` produce no spec but do print the sidecar's wording),
and that prepending a page moves every image by exactly the buffer's line delta.

`f36-search-jump-check.lua` covers what a search that only finds what is already on screen
cannot be distinguished from: that `render_full` records where each message landed
(including the banner/hint offset), that `load_older`'s completion callback fires exactly
once down **every** exit — the two-rung ladder, the error path, and the refusals — and that
the jump reports its three outcomes with wording that never claims a message does not
exist. It also asserts the panel's row↔result mapping, written as a list rather than a
table keyed by line: `mapping[1] = nil` is not a key with a nil value in Lua, it is no key
at all, and `pairs()` would skip exactly the two rows that must have *no* result.

`f38-attachment-open-check.lua` swaps the opener for one that records what it was asked to
open (same seam as `image.set_renderer`) and asserts the four paths `o` has: a video
reaches the opener via `fetch_media` with `chat_id` attached, a text line neither fetches
nor opens, an `unavailable` shows the sidecar's wording and opens nothing, and a second
press while a fetch is in the air neither re-requests nor re-opens.

`f63-degraded-signal-check.lua` runs nine transitions through one accumulating state
machine, in order, with no reset between them — the order is itself what is under test.
Three of them are the same invariant from three directions: the supervisor's reopen timer,
the poll timer and `recoverSession` are independent clocks, so `sse_restored` can arrive
while the connection is still unreachable, `connected` can arrive before `sse_restored`, and
`sse_degraded` can land mid-reconnect. In each case the status line and the notice have to
agree — `[polling]` with nothing on screen explaining it, or a standing "daemon is not
running" wiped by a delivery update, are both the screen lying.

`f62-notice-anchor-check.lua` and `f62-notice-onscreen-check.sh` are two layers of the same
check and neither replaces the other. **The first one was ALL PASS while the screen was
empty.** It asserted the shape of the extmark that had been created — and `virt_lines_above`
anchored at line 0 creates a perfectly valid extmark that Neovim has nowhere to draw and
silently never renders. "Created" and "drawn" are different claims. So the `.sh` runs a real
Neovim with a real UI inside tmux and greps `capture-pane`: the notice is on screen, the
first chat is still on screen, and the notice's row number is *lower* than the first chat's.
Where a check can read the characters a user would see, it should.

**Know what these scripts cannot see.** The fake renderer produces no virtual lines, so
anything about how much space an image actually occupies on screen is invisible to it. A
version of this feature reserved real blank lines *and* let image.nvim reserve virtual
ones, leaving a second gap under every picture the same height as the picture — both
scripts stayed green throughout, and a person spotted it in seconds. Mechanical assertions
own placement; a human owns whether the screen looks right.

**A stub replaces the slowest part of the system, so no stubbed script can see time.**
`f38-attachment-open-check.lua` was green at 7/7 while every uncached Telegram attachment
failed in real use: the Lua layer expired pending requests after 10s, and fetching one
takes 14-40s. The stub answered instantly, so the deadline was never exercised. The fix is
not to make the test wait a minute — it is to make the rule askable: `sidecar._is_stale` is
a pure function, and the script asserts it directly (default 10s, 60s when the request asks
for it). **Time-dependent logic has to be a question you can ask, not only something you can
sit through.**

Conventions for these scripts:

- Write results with `io.write`, never `print` / `vim.notify` — queued messages hit
  "Press ENTER" and hang a headless run.
- Set `vim.o.lines` / `vim.o.columns` and load enough messages to outgrow the window.
  Headless defaults leave `topline` at 1, where a topline assertion tests nothing — assert
  `topline > 1` first and fail loudly if it does not hold.
- Have the stub answer inside `vim.schedule`, matching the real sidecar, so the callback's
  own scheduling is exercised. Wait on a condition (`vim.wait(2000, cond)`), never a fixed
  sleep. To assert that *no* further request happens, wait once more before claiming it.
- Mutate the code under test once and confirm the assertion turns red. An assertion that
  passes against a deliberately broken implementation is decoration.

## Latency instrumentation

Phase 4 adds timestamp-based latency tracking:
- `msg_timestamp` (LINE's `createdTime`) → `sidecar_received_at` (`Date.now()`) → `lua_rendered_at` (`vim.loop.gettimeofday()`)
- Sidecar emits `sidecar_received_at` and `msg_timestamp` in `resource_updated` notification params (see sidecar-protocol.md)
- Lua `log_latency()` in init.lua calculates IPC hop (`lua_rendered_at - sidecar_received_at`) and full chain (`sidecar_received_at - msg_timestamp + IPC`)
- Log to `/tmp/chat-nvim-latency.log` (append mode, one line per notification)
- Format: `YYYY-MM-DD HH:MM:SS | ipc=Nms | chain=Nms | total=Nms`
- Target: p95 full-chain < 2 seconds
- Note: `msg_timestamp` vs `sidecar_received_at` spans machines (possible clock skew). `sidecar_received_at` vs `lua_rendered_at` is local IPC, same machine.
- Use `vim.loop.gettimeofday()` for Lua timing — NOT `vim.loop.now()` (monotonic, can't compare with epoch)
