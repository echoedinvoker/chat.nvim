-- Mechanical check for opening a non-image attachment (F38): does `o` reach the external
-- program with the right bytes, and does it stay quiet everywhere else?
--
--   nvim --headless -l scripts/f38-attachment-open-check.lua
--
-- The sidecar is stubbed and the real opener is swapped for one that only records what it
-- was asked to open, so this asserts the Lua layer alone: no daemon, no DB, no mpv. It
-- exists because three of the four failures here are invisible on screen — a text line
-- that quietly fires a fetch, an `unavailable` that still opens something, and a held `o`
-- that opens the external program once per keypress all look like nothing happened.
--
-- Output goes to stdout via io.write. print/vim.notify would queue up messages and hit
-- "Press ENTER", which hangs a headless run.

vim.opt.runtimepath:append(vim.fn.getcwd())

vim.o.lines = 24
vim.o.columns = 80

--------------------------------------------------------------------------------
-- Stub sidecar, installed before any chat-nvim module is required. Same seam
-- f34-anchor-check.lua and f36-search-jump-check.lua use; no test-only entry point in the
-- plugin itself.
--
-- A responder returning nil means "hold this reply": the request is recorded and its
-- callback parked, which is how the in-flight case below is produced without a timer.
--------------------------------------------------------------------------------

local requests = {}
local held = {}
local responder = nil

package.loaded["chat-nvim.sidecar"] = {
  send = function(method, params, cb)
    table.insert(requests, { method = method, params = params })
    if not cb then return end
    local result = responder and responder(method, params, #requests) or nil
    if result == nil then
      table.insert(held, cb)
      return
    end
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
local attachment = require("chat-nvim.ui.attachment")

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
-- Setup
--------------------------------------------------------------------------------

local CHAT = "telegram:-100123"

state.reset()
messages.open(CHAT)
state.update_messages(CHAT, {
  -- Newest first, as the API returns them; state reverses to chronological.
  { id = "telegram:2", sender_name = "Bob", text = "[影片]", timestamp = 1690000001000, content_type = "video" },
  { id = "telegram:1", sender_name = "Bob", text = "hello",  timestamp = 1690000000000, content_type = "text" },
})
messages.render_full(CHAT)

local win = messages.get_winnr()
local rows = state.msg_rows and state.msg_rows[CHAT]
if not win or not rows then
  io.write("FAIL: setup no messages window or no msg_rows\n")
  os.exit(1)
end

local opened = {}
attachment.set_opener(function(path) table.insert(opened, path) end)

local function cursor_on(id, offset)
  -- msg_rows is 0-based, cursor lines are 1-based.
  vim.api.nvim_win_set_cursor(win, { rows.by_id[id] + 1 + (offset or 0), 0 })
end

local function reset_probe()
  requests, held, opened = {}, {}, {}
end

--------------------------------------------------------------------------------
-- ① the video path: the cursor sits on the body line, not the header, because that is
-- where a reader's cursor actually is. The id is resolved by walking up to the nearest
-- header row; a version that only reads the exact row under the cursor passes every
-- header-row test and does nothing in real use.
--------------------------------------------------------------------------------

reset_probe()
responder = function() return { path = "/tmp/probe.mp4" } end
cursor_on("telegram:2", 1)
attachment.open_at_cursor()
vim.wait(500, function() return #opened > 0 end)

local req = requests[1]
ok("4.1 video under the cursor reaches the opener via fetch_media",
  #opened == 1 and opened[1] == "/tmp/probe.mp4"
    and req and req.method == "fetch_media"
    and req.params.chat_id == CHAT
    and req.params.message_id == "telegram:2",
  ("opened=%s request=%s"):format(vim.inspect(opened), vim.inspect(requests)))

--------------------------------------------------------------------------------
-- ② a text message must not reach the opener, and must not cost a round trip either.
--------------------------------------------------------------------------------

reset_probe()
cursor_on("telegram:1")
attachment.open_at_cursor()
vim.wait(200)

ok("4.1 a text message neither fetches nor opens",
  #opened == 0 and #requests == 0,
  ("opened=%d requests=%d"):format(#opened, #requests))

ok("4.1 a text message says so in the buffer, not in the cmdline",
  attachment.last_status():find("沒有可開啟的附件") ~= nil,
  attachment.last_status())

--------------------------------------------------------------------------------
-- ③ `unavailable` must not reach the opener, and the wording shown is the sidecar's.
-- Lua composing its own second version of these strings is the drift this forbids.
--------------------------------------------------------------------------------

reset_probe()
responder = function() return { unavailable = "gone", text = "[附件已不存在於 Telegram]" } end
cursor_on("telegram:2")
attachment.open_at_cursor()
vim.wait(500, function() return attachment.last_status():find("不存在") ~= nil end)

ok("4.1 unavailable shows the sidecar's wording and opens nothing",
  #opened == 0 and attachment.last_status() == "[附件已不存在於 Telegram]",
  ("opened=%d status=%q"):format(#opened, attachment.last_status()))

--------------------------------------------------------------------------------
-- ④ re-entrancy. `[` has state.in_flight; this path needs the equivalent guard, or
-- holding `o` down launches the external program once per keypress and the virtual-text
-- updates overwrite each other.
--------------------------------------------------------------------------------

reset_probe()
responder = nil                       -- hold the reply
cursor_on("telegram:2")
attachment.open_at_cursor()
attachment.open_at_cursor()           -- second press, first request still in the air
ok("4.1 a second press while a fetch is in flight sends no second request",
  #requests == 1, ("requests=%d"):format(#requests))

for _, cb in ipairs(held) do cb({ path = "/tmp/probe.mp4" }, nil) end
vim.wait(500, function() return #opened > 0 end)
vim.wait(200, function() return #opened > 1 end)   -- give a wrong second open its chance
ok("4.1 the single reply opens the attachment exactly once",
  #opened == 1, ("opened=%d"):format(#opened))

-- And the guard must be released, or `o` on that attachment is dead for the rest of the
-- session with nothing on screen to say why — the stale-`true` shape from R6.
reset_probe()
responder = function() return { path = "/tmp/probe.mp4" } end
cursor_on("telegram:2")
attachment.open_at_cursor()
vim.wait(500, function() return #opened > 0 end)
ok("4.1 the in-flight guard is cleared once the reply lands",
  #opened == 1, ("opened=%d requests=%d"):format(#opened, #requests))

--------------------------------------------------------------------------------

if passed ~= checks then
  io.write(("FAILED: %d of %d\n"):format(checks - passed, checks))
  os.exit(1)
end
io.write(("OK: %d/%d\n"):format(passed, checks))
os.exit(0)
