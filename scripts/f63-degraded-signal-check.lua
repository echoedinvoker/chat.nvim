-- Mechanical check for F63-D: does the *degraded* signal reach state, the status line and
-- a buffer — and does it stay out of the way of the connection states?
--
--   nvim --headless -l scripts/f63-degraded-signal-check.lua
--
-- The stream is only a latency hint; the poll is what makes delivery correct. So its death
-- means "slower", never "disconnected", and delivery lives in a variable of its own
-- (decision D) — connection is four mutually exclusive states with last write wins, and
-- "the daemon is gone" and "the stream will not open" are true at the same time.
--
-- Checks 6, 7 and 8 are the three directions of one invariant, and they are the reason the
-- notice has a single production point behind a `state.connection ~= "connected"` guard:
-- the supervisor's reopen timer, the poll timer and recoverSession are three independent
-- clocks, so every ordering below is routine rather than exotic.
--
-- The nine checks share one accumulating state machine and run in order, with no reset
-- between them. That is deliberate: the order of the transitions is itself under test. Do
-- not insert resets or reorder them for tidiness.
--
-- The sidecar is stubbed, so this asserts the Lua layer alone: no daemon, no socket.
--
-- Output goes to stdout via io.write. print/vim.notify would queue messages and hit
-- "Press ENTER", which hangs a headless run.

vim.opt.runtimepath:append(vim.fn.getcwd())

-- chat-nvim.init requires the sidecar at load time, so this has to come first.
package.loaded["chat-nvim.sidecar"] = {
  send = function() end,
  start = function() end,
  stop = function() end,
  is_running = function() return true end,
  set_notification_handler = function() end,
}

local state = require("chat-nvim.state")
local init = require("chat-nvim.init")
local chat_list = require("chat-nvim.ui.chat_list")
local fails = 0

local function check(label, cond)
  if not cond then fails = fails + 1 end
  io.write((cond and "ok   " or "FAIL ") .. label .. "\n")
end

local notice_ns = vim.api.nvim_create_namespace("chat_nvim_notice")

local function notice_marks()
  local buf = chat_list.get_bufnr()
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return {} end
  return vim.api.nvim_buf_get_extmarks(buf, notice_ns, 0, -1, { details = true })
end

local function notice_count()
  return #notice_marks()
end

--- The notice text, however it is carried. F62 turns virt_text/overlay into virt_lines, so
--- reading only one of them would make this script silently stop asserting halfway through
--- Phase 5.
local function notice_text()
  local mark = notice_marks()[1]
  if not mark then return "" end
  local d = mark[4] or {}
  local out = {}
  for _, chunk in ipairs(d.virt_text or {}) do out[#out + 1] = chunk[1] end
  for _, line in ipairs(d.virt_lines or {}) do
    for _, chunk in ipairs(line) do out[#out + 1] = chunk[1] end
  end
  return table.concat(out)
end

local notify = init._test_handle_notification

chat_list.open()

-- 0. baseline. Without it every check below is a false red: state starts at
--    "disconnected", and [polling] is checked *after* the three connection states, so
--    statusline() would answer "[disconnected]" and the notice guard would refuse to speak.
notify("connected", {})
check("baseline: connected", state.connection == "connected")

-- 1. the degraded signal lands in state and in the status line
notify("sse_degraded", { consecutive_failures = 3, poll_ms = 15000 })
check("state.delivery says polling", state.delivery == "polling")
check("status line says [polling]", init.statusline() == "[polling]")

-- 2. the number comes from the sidecar, not from a hardcoded 15 (decision E: the interval
--    is CHATMUX_POLL_MS and anyone can change it)
check("notice states 15s", notice_text():find("15s", 1, true) ~= nil)
notify("sse_degraded", { consecutive_failures = 3, poll_ms = 120000 })
check("notice follows poll_ms to 120s", notice_text():find("120s", 1, true) ~= nil)

-- 3. recovery clears it
notify("sse_restored", {})
check("state.delivery back to push", state.delivery == "push")
check("status line no longer [polling]", init.statusline() ~= "[polling]")

-- 4. connection outranks delivery: telling the user "push is degraded" while the daemon is
--    gone is noise — [daemon offline] is what they need
notify("sse_degraded", { consecutive_failures = 3, poll_ms = 15000 })
notify("daemon_unreachable", { code = "FailedToOpenSocket" })
check("daemon offline outranks polling", init.statusline() == "[daemon offline]")

-- 5. the single notice slot ends up empty once everything has recovered
notify("sse_degraded", { consecutive_failures = 3, poll_ms = 15000 })
notify("daemon_unreachable", { code = "FailedToOpenSocket" })
notify("sse_restored", {})
notify("connected", {})
check("notice slot is empty after full recovery", notice_count() == 0)

-- 6. invariant, direction one: the poll usually reaches `connected` before the supervisor's
--    backoff fires, so this is the ordering with no sse_restored at all. "The status line
--    says [polling]" and "there is a line on screen explaining it" must be true together.
notify("sse_degraded", { consecutive_failures = 3, poll_ms = 15000 })
notify("daemon_unreachable", { code = "FailedToOpenSocket" })
notify("connected", {})
check(
  "[polling] and its explanation hold together",
  (init.statusline() == "[polling]") == (notice_count() > 0)
)
check("and both are true here, not both false", init.statusline() == "[polling]")

-- 7. invariant, direction two: the supervisor can also win the race. sse_restored arriving
--    while the connection is still unreachable must not wipe a message that is still true.
notify("daemon_unreachable", { code = "FailedToOpenSocket" })
notify("sse_restored", {})
check(
  "the daemon notice survives an early sse_restored",
  notice_text():find("daemon is not running", 1, true) ~= nil
)

-- 8. invariant, direction three: reconnecting is unhealthy too. The guard is written as
--    `~= "connected"` rather than a list of states because enumerating them has already
--    missed two. A non-empty notice is raised first on purpose — otherwise this would only
--    prove the guard stops the notice appearing from nothing.
notify("connected", {})
notify("daemon_unreachable", { code = "FailedToOpenSocket" })
notify("reconnecting", {})
notify("sse_degraded", { consecutive_failures = 3, poll_ms = 15000 })
check("status line still [reconnecting]", init.statusline() == "[reconnecting]")
check(
  "the standing notice was not overwritten mid-reconnect",
  notice_text():find("daemon is not running", 1, true) ~= nil
)

io.write(fails == 0 and "ALL PASS\n" or (fails .. " FAILED\n"))
vim.cmd("cquit " .. (fails == 0 and 0 or 1))
