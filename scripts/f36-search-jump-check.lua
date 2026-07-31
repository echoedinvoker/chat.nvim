-- Mechanical check for searching the full local history (F36): can a hit that is not on
-- screen be located at all?
--
--   nvim --headless -l scripts/f36-search-jump-check.lua
--
-- The sidecar is stubbed, so this asserts the Lua layer alone: no daemon, no DB, no
-- network. It exists because the failure this round is invisible to the eye — a search
-- that only ever finds what is already loaded looks exactly like one that works, and a
-- jump that lands on the neighbouring message still "jumped to a message".
--
-- Output goes to stdout via io.write. print/vim.notify would queue up messages and hit
-- "Press ENTER", which hangs a headless run.

vim.opt.runtimepath:append(vim.fn.getcwd())

vim.o.lines = 24
vim.o.columns = 80

--------------------------------------------------------------------------------
-- Stub sidecar. Installed before any chat-nvim module is required, so messages.open()
-- builds its buffer, window and keymaps without a real daemon: `send` records the request
-- and simply never answers, which leaves the initial read_messages hanging in the air.
-- Same seam f34-anchor-check.lua uses; no test-only entry point in the plugin itself.
--------------------------------------------------------------------------------

local requests = {}
local responder = nil       -- nil = never call back

package.loaded["chat-nvim.sidecar"] = {
  send = function(method, params, cb)
    table.insert(requests, { method = method, params = params })
    if not cb or not responder then return end
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

local checks, passed = 0, 0

local function ok(label, cond, detail)
  checks = checks + 1
  if cond then
    passed = passed + 1
    io.write(("ok  : %s\n"):format(label))
  else
    io.write(("FAIL: %s %s\n"):format(label, detail or ""))
  end
  return cond and true or false
end

--------------------------------------------------------------------------------
-- Group A (3.1): render_full records where each message landed.
--
-- Banner and hint are both present so the header offset is non-zero: a table built from
-- format_messages' rows without that offset would still be self-consistent, and would
-- still point at the wrong lines.
--------------------------------------------------------------------------------

local CHAT = "line:c_probe"

state.reset()
state.banners[CHAT] = "banner line"
state.older_hint[CHAT] = "older hint line"

messages.open(CHAT)
state.update_messages(CHAT, {
  -- Newest first, as the API returns them; state reverses to chronological, so the buffer
  -- order is m3, m2, m1. The assertions below are order-independent on purpose.
  { id = "line:m3", sender_name = "Alice", text = "three",   timestamp = 1690000002000 },
  { id = "line:m2", sender_name = "Bob",   text = "a\nb\nc", timestamp = 1690000001000 },
  { id = "line:m1", sender_name = "Alice", text = "one",     timestamp = 1690000000000 },
})
messages.render_full(CHAT)

local bufnr = messages.get_bufnr()
local winnr = messages.get_winnr()
if not bufnr or not winnr then
  io.write("FAIL: setup no messages window\n")
  os.exit(1)
end

local rows = state.msg_rows and state.msg_rows[CHAT]
if not rows then
  io.write("FAIL: state.msg_rows has no entry for the chat\n")
  io.write("FAILED: 0 of 3\n")
  os.exit(1)
end

for _, id in ipairs({ "line:m1", "line:m2", "line:m3" }) do
  local row = rows.by_id[id]
  local line = row and vim.api.nvim_buf_get_lines(bufnr, row, row + 1, false)[1]
  ok(("3.1 %s sits on its own header row"):format(id),
    line and line:match("^## ") and rows.by_row[row] == id,
    ("row=%s holds %q, by_row=%s"):format(tostring(row), tostring(line), tostring(row and rows.by_row[row])))
end

--------------------------------------------------------------------------------
-- Group B (3.2): parking the cursor on a message, and a paging callback that fires.
--------------------------------------------------------------------------------

ok("3.2 focus_message lands on a loaded id",
  messages.focus_message(CHAT, "line:m2")
    and vim.api.nvim_win_get_cursor(winnr)[1] == state.msg_rows[CHAT].by_id["line:m2"] + 1,
  ("cursor=%d want=%d"):format(
    vim.api.nvim_win_get_cursor(winnr)[1],
    (state.msg_rows[CHAT].by_id["line:m2"] or -1) + 1))

local before_cursor = vim.api.nvim_win_get_cursor(winnr)
ok("3.2 focus_message on an unknown id returns false and leaves the cursor alone",
  messages.focus_message(CHAT, "line:nope") == false
    and vim.deep_equal(vim.api.nvim_win_get_cursor(winnr), before_cursor),
  vim.inspect(vim.api.nvim_win_get_cursor(winnr)))

-- on_done fires exactly once, including down the rung-2 retry path. The first reply adds
-- nothing but still says has_more, which is exactly what drives request_older into rung 2:
-- a callback wired only to the normal exit would fire twice, and one wired only to rung 1
-- would never fire at all.
local baseline = #requests
local calls = 0
responder = function()
  calls = calls + 1
  if calls == 1 then return { messages = {}, has_more = true } end
  return { messages = {}, has_more = false }
end

local fired = 0
messages.load_older(CHAT, function() fired = fired + 1 end)
vim.wait(1000, function() return fired > 0 and not state.in_flight[CHAT] end)
-- Give a second (wrong) firing the chance to appear before claiming there was none.
vim.wait(300, function() return fired > 1 end)
responder = nil

ok("3.2 load_older's on_done fires exactly once across the two-rung ladder",
  fired == 1 and #requests - baseline == 2,
  ("fired=%d over %d request(s)"):format(fired, #requests - baseline))

-- Every early return must answer too, or the jump loop waits for a callback that is never
-- coming — the same silent-stall shape as a stale in_flight.
state.has_more[CHAT] = false
local refused = 0
messages.load_older(CHAT, function() refused = refused + 1 end)
vim.wait(300, function() return refused > 0 end)
ok("3.2 load_older still answers when it refuses to page (has_more == false)",
  refused == 1, ("fired=%d"):format(refused))
state.has_more[CHAT] = nil

--------------------------------------------------------------------------------
-- Group C (3.3): the panel's two pieces of pure logic.
--------------------------------------------------------------------------------

local search = require("chat-nvim.ui.search")

-- The FTS branch wraps hits in <b>…</b>; the LIKE branch (query shorter than 3 characters)
-- hands back the whole content_text, unmarked and possibly multi-line. Both arrive here.
local snippet_cases = {
  { "晚上要不要吃<b>火鍋</b>", 40, "晚上要不要吃火鍋" },
  { "第一行\n第二行\n第三行",   40, "第一行 第二行 第三行" },
  { string.rep("字", 60),      10, string.rep("字", 10) },
  { "<b>a</b>\n<b>b</b>",      40, "a b" },
}
for _, c in ipairs(snippet_cases) do
  local got = search._clean_snippet(c[1], c[2])
  ok(("3.3 snippet %q"):format(c[1]), got == c[3], ("got %q want %q"):format(tostring(got), c[3]))
end

-- Line ↔ result mapping. The status line is row 1, so result n lives on row n+1. Written as
-- a list, not a table keyed by line: `mapping[1] = nil` is not a key with a nil value in
-- Lua, it is no key at all, and pairs() would skip exactly the two rows that must have no
-- result — the off-by-one this whole assertion exists to catch.
search._set_results({
  { message = { id = "line:r1", chat_id = CHAT }, snippet = "s1", chat_name = "C" },
  { message = { id = "line:r2", chat_id = CHAT }, snippet = "s2", chat_name = "C" },
  { message = { id = "line:r3", chat_id = CHAT }, snippet = "s3", chat_name = "C" },
})
local mapping = {
  { line = 1 },                      -- the status line is not a result
  { line = 2, want = "line:r1" },
  { line = 3, want = "line:r2" },
  { line = 4, want = "line:r3" },
  { line = 5 },                      -- past the last result
}
for _, m in ipairs(mapping) do
  local got = search._result_at(m.line)
  local got_id = got and got.message.id or nil
  ok(("3.3 row %d -> %s"):format(m.line, tostring(m.want)),
    got_id == m.want, ("got %s"):format(tostring(got_id)))
end

--------------------------------------------------------------------------------
-- Group D (3.4): paging backwards until the target is on screen — or saying, accurately,
-- why it is not. load_older is injected so the three outcomes can be produced on demand.
--------------------------------------------------------------------------------

-- ① the target surfaces on the second page
local pages = 0
search._jump_to_id(CHAT, "line:deep", {
  max_pages = 20,
  load_older = function(_, on_done)
    pages = pages + 1
    if pages == 2 then
      state.append_messages(CHAT, {
        { id = "line:deep", sender_name = "Alice", text = "needle", timestamp = 1689999999000 },
      })
      state.sort_messages(CHAT)
      messages.render_full(CHAT)
    end
    state.has_more[CHAT] = true
    on_done()
  end,
})
vim.wait(1000, function() return state.msg_rows[CHAT].by_id["line:deep"] ~= nil end)
ok("3.4 pages back until the target is loaded, then focuses it",
  pages == 2 and messages.focus_message(CHAT, "line:deep"),
  ("paged %d time(s)"):format(pages))

-- ② the local DB runs out. F34's rule: has_more == false means this machine has no more,
-- which is not the same as the message not existing on the platform.
search._jump_to_id(CHAT, "line:absent", {
  max_pages = 20,
  load_older = function(_, on_done) state.has_more[CHAT] = false; on_done() end,
})
vim.wait(1000, function() return search.get_status():find("本機已載完") ~= nil end)
local exhausted = search.get_status()
ok("3.4 exhausted status says the local DB ran out, never that the message does not exist",
  exhausted:find("本機已載完") and not exhausted:find("不存在"), exhausted)

-- ③ the page cap. Stopping is fine; pretending the search was complete is not.
state.has_more[CHAT] = true
search._jump_to_id(CHAT, "line:absent", {
  max_pages = 20,
  load_older = function(_, on_done) state.has_more[CHAT] = true; on_done() end,
})
vim.wait(3000, function() return search.get_status():find("無法定位：已往回") ~= nil end)
local capped = search.get_status()
ok("3.4 hitting the page cap reports the cap and that older messages remain locally",
  capped:find("20") and capped:find("仍有更舊"), capped)

--------------------------------------------------------------------------------

if passed ~= checks then
  io.write(("FAILED: %d of %d\n"):format(checks - passed, checks))
  os.exit(1)
end
io.write(("OK: %d/%d\n"):format(passed, checks))
os.exit(0)
