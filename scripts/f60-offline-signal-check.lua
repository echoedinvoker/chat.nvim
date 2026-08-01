-- Mechanical check for F60/F55: does the offline signal reach state, the status line,
-- and a buffer — and does it survive a chat-list redraw?
--
--   nvim --headless -l scripts/f60-offline-signal-check.lua
--
-- F55's finding was that the connection states were *correct* and nobody could see them.
-- So this asserts the carriers, not just the value: the status line string, an extmark on
-- a real buffer, that extmark still being there after render() has replaced every line,
-- and the fallback to the messages buffer when the chat list is not open.
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
local notify = require("chat-nvim.ui.notify")
local chat_list = require("chat-nvim.ui.chat_list")
local messages = require("chat-nvim.ui.messages")
local passed, total = 0, 0

local function check(label, cond)
  total = total + 1
  if cond then passed = passed + 1 end
  io.write((cond and "ok   " or "FAIL ") .. label .. "\n")
end

local ns = vim.api.nvim_create_namespace("chat_nvim_notice")
local function notice_count(buf)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return 0 end
  return #vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {})
end

-- The chat list has to exist first, so check 2 measures "survives a redraw" and not
-- "gets applied late" — those are different guarantees and check 5 owns the latter.
chat_list.open()

-- 1. the notification lands in state, in the status line, and on the buffer
init._test_handle_notification("daemon_unreachable", { code = "FailedToOpenSocket" })
check("state says the daemon is unreachable", state.connection == "daemon_unreachable")
check("status line says [daemon offline]", init.statusline() == "[daemon offline]")
check("notice is on the chat list", notice_count(chat_list.get_bufnr()) > 0)

-- 2. it survives a chat-list redraw (a redraw replaces every line, and extmarks go with
--    the lines they were anchored to)
chat_list.render()
check("notice survives render", notice_count(chat_list.get_bufnr()) > 0)

-- 3. connected clears it
init._test_handle_notification("connected", {})
check("state back to connected", state.connection == "connected")
check("status line no longer offline", init.statusline() ~= "[daemon offline]")
check("notice cleared", notice_count(chat_list.get_bufnr()) == 0)

-- 4. with no chat list, the messages buffer carries it instead.
--    Order matters: messages.open() opens the chat-list pane alongside itself, so closing
--    the chat list first would just have it reappear and take the notice.
messages.open("c")
chat_list.close()
init._test_handle_notification("daemon_unreachable", { code = "FailedToOpenSocket" })
check("notice falls back to the messages buffer", notice_count(messages.get_bufnr()) > 0)

-- 5. with neither buffer open the notice is still held, and goes up when one appears.
--    A signal that only works when a window happens to be open is the F55 bug again.
init._test_handle_notification("connected", {})
-- A spare window first: with the chat list already closed, the messages pane is the last
-- one and Neovim refuses to close it (E444).
vim.cmd("new")
messages.close()
local ok = pcall(function()
  init._test_handle_notification("daemon_unreachable", { code = "FailedToOpenSocket" })
end)
check("raising a notice with no buffer open does not error", ok)
chat_list.open()
chat_list.render()
check("the held notice appears once a buffer opens", notice_count(chat_list.get_bufnr()) > 0)

io.write(string.format("%s: %d/%d\n", passed == total and "PASS" or "FAILED", passed, total))
vim.cmd(passed == total and "qa!" or "cq")
