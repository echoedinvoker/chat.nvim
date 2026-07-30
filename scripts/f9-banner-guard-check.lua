-- Mechanical check for the banner guard (F9): does a push that says nothing about the
-- banner leave it alone, and does an explicit null still clear it?
--
--   nvim --headless -l scripts/f9-banner-guard-check.lua
--
-- The event-tail push carries only the messages that changed, so it has no `banner` key at
-- all. Recomputing the banner from that absence wipes F34's history notice — a line
-- disappears and nothing errors, which is exactly the kind of regression a screenshot
-- taken a second later cannot settle.
--
-- The sidecar is stubbed, so this asserts the Lua layer alone: no daemon, no DB, no
-- network.
--
-- Output goes to stdout via io.write. print/vim.notify would queue up messages and hit
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
local passed, total = 0, 0

local function check(label, cond)
  total = total + 1
  if cond then passed = passed + 1 end
  io.write((cond and "ok   " or "FAIL ") .. label .. "\n")
end

-- Stay out of the render path: this checks the banner state machine, not the screen.
-- Whether the banner is actually drawn is Phase 3.5's job, on a real buffer.
state.current_chat = nil

-- No key at all = this push is not talking about the banner.
state.banners["c"] = "歷史不可得"
init._test_handle_resource_updated({ uri = "chat://chats/c/messages", messages = {} })
check("a keyless push leaves the banner alone", state.banners["c"] == "歷史不可得")

-- Key present, value null = "there is no banner", so it must clear.
init._test_handle_resource_updated({
  uri = "chat://chats/c/messages", messages = {}, banner = vim.NIL,
})
check("an explicit null clears the banner", state.banners["c"] == nil)

-- Key present with a value = updates as before.
init._test_handle_resource_updated({
  uri = "chat://chats/c/messages", messages = {}, banner = "新橫幅",
})
check("a string banner still updates", state.banners["c"] == "新橫幅")

io.write(string.format("%s: %d/%d\n", passed == total and "PASS" or "FAILED", passed, total))
vim.cmd(passed == total and "qa!" or "cq")
