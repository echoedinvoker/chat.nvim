-- Mechanical check for loading older history (F34): does the view stay put, and does the
-- paging ladder stop?
--
--   nvim --headless -l scripts/f34-anchor-check.lua
--
-- The sidecar is stubbed, so this asserts the Lua layer alone: no daemon, no DB, no
-- network. It exists because "the screen looks like it did not jump" is not something a
-- screenshot can settle — the two failure modes it covers (an off-by-delta cursor, and a
-- ladder that never terminates) both look fine for the first second.
--
-- Output goes to stdout via io.write. print/vim.notify would queue up messages and hit
-- "Press ENTER", which hangs a headless run.

vim.opt.runtimepath:append(vim.fn.getcwd())

-- Big enough that the buffer outgrows the window; without that, topline is always 1 and
-- assertion 3 would silently test nothing.
vim.o.lines = 24
vim.o.columns = 80

--------------------------------------------------------------------------------
-- Stub sidecar: records every request, answers from a per-test responder.
--------------------------------------------------------------------------------

local requests = {}
local responder = function() return nil end

package.loaded["chat-nvim.sidecar"] = {
  send = function(method, params, cb)
    table.insert(requests, { method = method, params = params })
    if not cb then return end
    local result = responder(method, params, #requests)
    -- The real sidecar answers off the event loop; keeping that shape means the callback's
    -- own vim.schedule is exercised the same way it is in production.
    vim.schedule(function() cb(result, nil) end)
  end,
  start = function() end,
  stop = function() end,
  is_running = function() return true end,
  set_notification_handler = function() end,
}

local state = require("chat-nvim.state")
local messages = require("chat-nvim.ui.messages")

--------------------------------------------------------------------------------
-- Assertions
--------------------------------------------------------------------------------

local failures = 0

local function check(n, label, expected, actual)
  if expected ~= actual then
    io.write(("FAIL: %d %s expected=%s actual=%s\n")
      :format(n, label, vim.inspect(expected), vim.inspect(actual)))
    failures = failures + 1
    return false
  end
  io.write(("ok  : %d %s = %s\n"):format(n, label, vim.inspect(actual)))
  return true
end

local function check_true(n, label, cond, detail)
  return check(n, label .. " " .. (detail or ""), true, cond and true or false)
end

local function msg(i, ts)
  return {
    id = "line:m" .. i,
    chat_id = "line:c",
    sender_name = "S" .. (i % 3),
    timestamp = ts,
    text = "message body " .. i,
    is_self = false,
  }
end

--- API order is newest-first; the state layer reverses it.
local function newest_first(list)
  local out = {}
  for i = #list, 1, -1 do
    table.insert(out, list[i])
  end
  return out
end

local function line_at(bufnr, lnum)
  return vim.api.nvim_buf_get_lines(bufnr, lnum - 1, lnum, false)[1]
end

--------------------------------------------------------------------------------
-- Group A: anchoring. Two pages, all timestamps distinct.
--------------------------------------------------------------------------------

local CHAT_A = "line:cA"

local page1 = {}                      -- 60 messages, ts 1000..60000
for i = 41, 100 do
  table.insert(page1, msg(i, (i - 40) * 1000))
end
local page2 = {}                      -- 40 older ones, ts 10..400
for i = 1, 40 do
  table.insert(page2, msg(i, i * 10))
end

responder = function(_, params)
  if params.before == nil then
    return { messages = newest_first(page1), has_more = true,
             oldest_timestamp = 1000, banner = nil,
             older_hint = "↑ 還有更舊的訊息（按 [ 載入 50 筆）" }
  end
  return { messages = newest_first(page2), has_more = false,
           oldest_timestamp = 10, banner = nil,
           older_hint = "── 已載入本機全部；更舊的是否存在未知 ──" }
end

messages.open(CHAT_A)
vim.wait(2000, function()
  return state.messages[CHAT_A] ~= nil and #state.messages[CHAT_A] == #page1
end)

local bufnr = messages.get_bufnr()
local winnr = messages.get_winnr()
if not bufnr or not winnr then
  io.write("FAIL: setup no messages window\n")
  os.exit(1)
end

-- Park the reader mid-buffer and centre it, so topline is meaningfully above 1.
local before_count = vim.api.nvim_buf_line_count(bufnr)
vim.api.nvim_win_set_cursor(winnr, { math.floor(before_count / 2), 0 })
vim.api.nvim_win_call(winnr, function() vim.cmd("normal! zz") end)

local before_lnum = vim.api.nvim_win_get_cursor(winnr)[1]
local before_topline = vim.api.nvim_win_call(winnr, function()
  return vim.fn.winsaveview().topline
end)
local before_cursor_text = line_at(bufnr, before_lnum)
local before_top_text = line_at(bufnr, before_topline)

check_true(0, "setup: topline above 1 (else assertion 3 tests nothing)",
  before_topline > 1, "topline=" .. before_topline)
if before_topline <= 1 then
  io.write("FAILED: cannot assert anchoring without a scrolled window\n")
  os.exit(1)
end

messages.load_older(CHAT_A)
vim.wait(2000, function()
  return vim.api.nvim_buf_line_count(bufnr) > before_count
end)

local after_count = vim.api.nvim_buf_line_count(bufnr)
local after_lnum = vim.api.nvim_win_get_cursor(winnr)[1]
local after_topline = vim.api.nvim_win_call(winnr, function()
  return vim.fn.winsaveview().topline
end)

check_true(1, "buffer grew", after_count > before_count,
  ("%d -> %d"):format(before_count, after_count))
check(2, "line under cursor unchanged", before_cursor_text, line_at(bufnr, after_lnum))
check(3, "line at topline unchanged", before_top_text, line_at(bufnr, after_topline))

--------------------------------------------------------------------------------
-- Group B: the ladder. A whole page sharing one timestamp.
--------------------------------------------------------------------------------

local CHAT_B = "line:cB"
local TIE_TS = 777000

local tied = {}                       -- 50 distinct ids, one shared timestamp
for i = 1, 50 do
  table.insert(tied, msg(1000 + i, TIE_TS))
end

requests = {}
local open_requests = 0

responder = function(_, params)
  if params.before == nil then
    return { messages = newest_first(tied), has_more = true,
             oldest_timestamp = TIE_TS, banner = nil, older_hint = nil }
  end
  if params.before == TIE_TS + 1 then
    -- Inclusive rung: hands back exactly what is already loaded, so dedupe adds nothing.
    return { messages = newest_first(tied), has_more = true,
             oldest_timestamp = TIE_TS, banner = nil, older_hint = nil }
  end
  -- Strict rung: past the tie.
  return { messages = {}, has_more = false, oldest_timestamp = nil,
           banner = nil, older_hint = "── 已載入本機全部；更舊的是否存在未知 ──" }
end

messages.open(CHAT_B)
vim.wait(2000, function()
  return state.messages[CHAT_B] ~= nil and #state.messages[CHAT_B] == #tied
end)
open_requests = #requests

messages.load_older(CHAT_B)
-- Wait for the ladder to settle rather than for a fixed delay: in flight clears on every
-- callback exit, so "not in flight and at least one request made" means it stopped.
vim.wait(2000, function()
  return #requests > open_requests and not state.in_flight[CHAT_B]
end)
-- Give a third request the chance to appear before claiming there was none.
vim.wait(300, function() return #requests - open_requests > 2 end)

local paging = {}
for i = open_requests + 1, #requests do
  table.insert(paging, requests[i].params.before)
end

check(4, "rung 1 asks with before = oldest + 1 (inclusive of the tie)",
  TIE_TS + 1, paging[1])
check(5, "rung 2 retries with before = oldest (strict, guarantees progress)",
  TIE_TS, paging[2])
check(6, "the ladder stops at two requests", 2, #paging)

--------------------------------------------------------------------------------

if failures > 0 then
  io.write(("FAILED: %d of 6\n"):format(failures))
  os.exit(1)
end
io.write("OK: 6/6\n")
os.exit(0)
