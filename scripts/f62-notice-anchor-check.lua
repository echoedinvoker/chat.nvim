-- Mechanical check for F62: does a notice take a line of its own, or does it eat the first
-- chat in the list?
--
--   nvim --headless -l scripts/f62-notice-anchor-check.lua
--
-- `virt_text` with `virt_text_pos = "overlay"` anchored at line 0 *replaces* what is on that
-- line. The buffer text is untouched, so nothing in state or in the buffer looks wrong —
-- the first chat is simply not on screen while the notice is up.
--
-- The two call sites are repaired differently and that is deliberate. The standing notice
-- moved to the winbar, a row of the window's own. The transient message stayed an extmark,
-- as a virtual line below line 0: the winbar is one slot per window, and a standing
-- condition and a moment's message have to be able to coexist. Both are asserted (F45's
-- lesson: fixing only the site you happened to be looking at leaves the identical defect in
-- place next door), and the transient one is queried by its own namespace — `-1` would sweep
-- in chat_nvim_unread's highlights and pass for the wrong reason.
--
-- ⚠️ What this script CANNOT do: prove anything was drawn. `virt_lines_above` on line 0
-- creates a perfectly valid extmark that Neovim never renders — this file was ALL PASS while
-- the screen was empty. scripts/f62-notice-onscreen-check.sh is the check that runs a real
-- UI and reads the actual characters; neither replaces the other.
--
-- Output goes to stdout via io.write. print/vim.notify would queue messages and hit
-- "Press ENTER", which hangs a headless run.

vim.opt.runtimepath:append(vim.fn.getcwd())

package.loaded["chat-nvim.sidecar"] = {
  send = function() end,
  start = function() end,
  stop = function() end,
  is_running = function() return true end,
  set_notification_handler = function() end,
}

local state = require("chat-nvim.state")
local notify = require("chat-nvim.ui.notify")
local chat_list = require("chat-nvim.ui.chat_list")
local fails = 0

local function check(label, cond)
  if not cond then fails = fails + 1 end
  io.write((cond and "ok   " or "FAIL ") .. label .. "\n")
end

local error_ns = vim.api.nvim_create_namespace("chat_nvim_notify") -- notify.lua:3

local function first_line(buf)
  return vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1]
end

local function winbar()
  return vim.wo[vim.api.nvim_get_current_win()].winbar
end

local function transient_details(buf)
  local marks = vim.api.nvim_buf_get_extmarks(buf, error_ns, 0, -1, { details = true })
  return marks[1] and marks[1][4] or nil
end

chat_list.open()
local buf = chat_list.get_bufnr()
vim.api.nvim_set_current_win(vim.fn.bufwinid(buf))

-- Three known lines to sit under the notice. Written straight into the buffer rather than
-- through render(), so the assertion below is about the notice and nothing else.
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "AAA", "BBB", "CCC" })
vim.bo[buf].modifiable = false

-- 1-3. the standing notice
check("winbar starts empty", winbar() == "")
notify.set_persistent_notice("test notice")
-- True of the overlay version too — buffer text was never the thing that broke. It is here
-- so a future change that starts writing the notice into the buffer gets caught.
check("first buffer line is untouched", first_line(buf) == "AAA")
check("notice is carried by the winbar", winbar():find("test notice", 1, true) ~= nil)
check("notice does not sit on a buffer line", #vim.api.nvim_buf_get_extmarks(buf, error_ns, 0, -1, {}) == 0)

-- 4. it survives a chat-list redraw (F55's guarantee, which this round must not break)
state.chats = { { id = "c1", name = "AAA" } }
chat_list.render()
check("notice survives render", winbar():find("test notice", 1, true) ~= nil)

-- 5. a % in the text is not read as a statusline format item
notify.set_persistent_notice("100% gone")
check("a percent sign survives", winbar():find("100%% gone", 1, true) ~= nil)

notify.clear_persistent_notice()
check("clearing empties the winbar", winbar() == "")

-- 6-8. the transient message, still an extmark, in its own namespace
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "AAA", "BBB", "CCC" })
vim.bo[buf].modifiable = false
notify.show_error_in_chat_list("test error")
check("first buffer line is untouched (transient)", first_line(buf) == "AAA")
local e = transient_details(buf)
check("transient message is carried by virt_lines", e ~= nil and e.virt_lines ~= nil)
check("transient message does not overlay a line", e ~= nil and e.virt_text == nil)
-- virt_lines_above on line 0 is never drawn, so a "fix" that sets it is not a fix.
check("transient message is not drawn above line 0", e ~= nil and not e.virt_lines_above)

-- 9. the two carriers coexist — a standing condition and a moment's message are different
--    things, and neither may silence the other
notify.set_persistent_notice("standing")
check("standing notice and transient message coexist",
  winbar():find("standing", 1, true) ~= nil and transient_details(buf) ~= nil)

io.write(fails == 0 and "ALL PASS\n" or (fails .. " FAILED\n"))
vim.cmd("cquit " .. (fails == 0 and 0 or 1))
