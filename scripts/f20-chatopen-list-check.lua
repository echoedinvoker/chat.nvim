-- Mechanical check for F20.6: does :ChatOpen <id> fetch the chat list, or does it open an
-- empty pane that says "No chats found" while 143 chats exist?
--
--   nvim --headless -l scripts/f20-chatopen-list-check.lua
--
-- :ChatOpen opens the chat-list pane (messages.open calls chat_list.open) but nothing on
-- that path ever requests list_chats — only :ChatList did. The pane then renders the
-- empty-state line, which is a sentence that is simply false. A wrong sentence is worse
-- than a blank pane: the reader has no second source to overturn it.
--
-- The sidecar is stubbed, so this asserts the Lua layer alone: no daemon, no DB, no
-- network. Output goes to stdout via io.write; print/vim.notify would queue "Press ENTER"
-- and hang a headless run.

vim.opt.runtimepath:append(vim.fn.getcwd())

local sent = {}

-- chat-nvim.init requires the sidecar at load time, so this has to come first.
package.loaded["chat-nvim.sidecar"] = {
  send = function(method, params, cb)
    table.insert(sent, { method = method, params = params })
    if method == "list_chats" and cb then
      cb({ chats = { { id = "line:c1", name = "Room One" } } }, nil)
    end
  end,
  start = function() end,
  stop = function() end,
  is_running = function() return true end,
  set_notification_handler = function() end,
}

local state = require("chat-nvim.state")
local init = require("chat-nvim.init")
local chat_list = require("chat-nvim.ui.chat_list")

local passed, total = 0, 0

local function check(label, cond)
  total = total + 1
  if cond then passed = passed + 1 end
  io.write((cond and "ok   " or "FAIL ") .. label .. "\n")
end

local function sent_methods()
  local names = {}
  for _, s in ipairs(sent) do table.insert(names, s.method) end
  return table.concat(names, ",")
end

local function has_sent(method)
  for _, s in ipairs(sent) do
    if s.method == method then return true end
  end
  return false
end

state.init()
init.setup({})

-- Opening a single chat by id, with no prior :ChatList — a first-run reader's path.
init._chat_open("line:c1")
-- The response lands through vim.schedule, so waiting on the request alone would race it.
vim.wait(500, function() return has_sent("list_chats") and #state.chats > 0 end)

check(
  ":ChatOpen requests the chat list (sent: " .. sent_methods() .. ")",
  has_sent("list_chats")
)
check(
  ":ChatOpen leaves the chat list populated, not empty",
  #state.chats > 0
)

-- The pane must not be claiming there are no chats while chats exist.
local buf = chat_list.get_bufnr()
local says_no_chats = false
if buf and vim.api.nvim_buf_is_valid(buf) then
  for _, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    if line:match("No chats found") then says_no_chats = true end
  end
end
check("the chat-list pane does not say \"No chats found\"", not says_no_chats)

io.write(string.format("\n%d/%d checks passed\n", passed, total))
vim.cmd(passed == total and "cq 0" or "cq 1")
