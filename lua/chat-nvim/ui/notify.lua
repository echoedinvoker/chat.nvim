local M = {}

local ns = vim.api.nvim_create_namespace("chat_nvim_notify")

--- The current standing condition, or nil. Held in the module and not on a window because
--- it has to outlive both windows: a notice raised while nothing is open still has to show
--- up when the chat list is opened later.
local persistent_notice = nil

--- Every window currently showing one of our buffers, chat list first.
local function notice_windows()
  local out = {}
  for _, mod in ipairs({ "chat-nvim.ui.chat_list", "chat-nvim.ui.messages" }) do
    local buf = require(mod).get_bufnr()
    if buf and vim.api.nvim_buf_is_valid(buf) then
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_buf(win) == buf then
          out[#out + 1] = win
        end
      end
    end
  end
  return out
end

--- Put the standing notice on the first window that exists: the chat list, else messages.
--- Neither open is not an error — the status line is still saying it, and the notice goes
--- up as soon as a window appears. The two carriers back each other up; they are not an
--- either/or.
---
--- The carrier is the winbar, not a virtual line (F62). The original bug was `virt_text`
--- with `virt_text_pos = "overlay"` anchored at line 0, which *replaces* the first chat for
--- as long as the notice is up. The obvious repair — virt_lines with virt_lines_above —
--- silently does nothing: measured on nvim 0.12.3, a virtual line above line 0 has nowhere
--- to be drawn and is never rendered, while the extmark itself is created perfectly happily.
--- The winbar is a row of the window's own, so it takes a line without taking anyone's line,
--- and being window-local it also survives chat_list.render() by construction (F55).
local function apply_notice()
  if not persistent_notice then return end

  local win = notice_windows()[1]
  if not win then return end
  -- The winbar is evaluated as a statusline expression, so a literal % in a notice would be
  -- read as a format item and eat the character after it.
  vim.wo[win].winbar = "%#DiagnosticError#" .. persistent_notice:gsub("%%", "%%%%")
end

--- Raise a condition that stays on screen until it is cleared — as opposed to
--- `show_error_in_chat_list`, which is a moment's message.
function M.set_persistent_notice(text)
  persistent_notice = text
  apply_notice()
end

function M.clear_persistent_notice()
  persistent_notice = nil
  -- Every window, not just the one apply_notice picked: the chat list may have opened after
  -- the notice went up on the messages window, and a leftover winbar is a stale claim.
  for _, win in ipairs(notice_windows()) do
    vim.wo[win].winbar = ""
  end
end

--- For chat_list.render() to call once it has finished redrawing. Without it the notice is
--- correct in the module and invisible on screen.
function M.reapply_notice()
  apply_notice()
end

function M.send_feedback(text, is_error)
  local messages_ui = require("chat-nvim.ui.messages")
  local buf = messages_ui.get_bufnr()
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end

  local line_count = vim.api.nvim_buf_line_count(buf)
  local line = math.max(0, line_count - 1)

  local hl = is_error and "DiagnosticError" or "DiagnosticInfo"

  local mark_id = vim.api.nvim_buf_set_extmark(buf, ns, line, 0, {
    virt_text = { { "  " .. text, hl } },
    virt_text_pos = "eol",
  })

  vim.defer_fn(function()
    if vim.api.nvim_buf_is_valid(buf) then
      vim.api.nvim_buf_del_extmark(buf, ns, mark_id)
    end
  end, 3000)
end

--- A transient message: the next chat-list redraw clears `ns` and takes this with it. For a
--- condition that has to stay up until it ends, use `set_persistent_notice`.
function M.show_error_in_chat_list(text)
  local chat_list = require("chat-nvim.ui.chat_list")
  local buf = chat_list.get_bufnr()
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end

  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)

  -- Same defect as apply_notice had, and the same reason it matters (F62): overlay at line 0
  -- eats the first chat. This one is transient, which makes it easier to miss and no less
  -- wrong — a chat that vanishes for three seconds still looks like the list is broken.
  --
  -- The repair here is a virtual line *below* line 0, not the winbar apply_notice uses: the
  -- winbar is one slot per window, and these two are deliberately able to coexist (a standing
  -- condition and a moment's message are different things). Sharing one slot would rebuild
  -- the last-write-wins shape this round exists to remove. virt_lines_above is not an option
  -- either — above line 0 it is never drawn (measured, nvim 0.12.3).
  vim.api.nvim_buf_set_extmark(buf, ns, 0, 0, {
    virt_lines = { { { text, "DiagnosticError" } } },
  })
end

function M.clear_chat_list_error()
  local chat_list = require("chat-nvim.ui.chat_list")
  local buf = chat_list.get_bufnr()
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end

  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
end

return M
