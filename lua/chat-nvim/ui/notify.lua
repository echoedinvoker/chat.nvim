local M = {}

local ns = vim.api.nvim_create_namespace("chat_nvim_notify")

-- A namespace of its own, and that is the whole point (F55): chat_list.render() clears
-- `ns` wholesale on every redraw, so a notice sharing it would vanish seconds after it
-- appeared — looking exactly like the bug this is here to fix.
local notice_ns = vim.api.nvim_create_namespace("chat_nvim_notice")

--- The current standing condition, or nil. Held in the module and not on a buffer because
--- it has to outlive both buffers: a notice raised while nothing is open still has to show
--- up when the chat list is opened later.
local persistent_notice = nil

--- Put the standing notice on the first buffer that exists: the chat list, else messages.
--- Neither open is not an error — the status line is still saying it, and the notice goes
--- up as soon as a buffer appears. The two carriers back each other up; they are not an
--- either/or.
local function apply_notice()
  if not persistent_notice then return end

  for _, mod in ipairs({ "chat-nvim.ui.chat_list", "chat-nvim.ui.messages" }) do
    local buf = require(mod).get_bufnr()
    if buf and vim.api.nvim_buf_is_valid(buf) then
      vim.api.nvim_buf_clear_namespace(buf, notice_ns, 0, -1)
      vim.api.nvim_buf_set_extmark(buf, notice_ns, 0, 0, {
        virt_text = { { persistent_notice, "DiagnosticError" } },
        virt_text_pos = "overlay",
      })
      return
    end
  end
end

--- Raise a condition that stays on screen until it is cleared — as opposed to
--- `show_error_in_chat_list`, which is a moment's message.
function M.set_persistent_notice(text)
  persistent_notice = text
  apply_notice()
end

function M.clear_persistent_notice()
  persistent_notice = nil
  for _, mod in ipairs({ "chat-nvim.ui.chat_list", "chat-nvim.ui.messages" }) do
    local buf = require(mod).get_bufnr()
    if buf and vim.api.nvim_buf_is_valid(buf) then
      vim.api.nvim_buf_clear_namespace(buf, notice_ns, 0, -1)
    end
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

  vim.api.nvim_buf_set_extmark(buf, ns, 0, 0, {
    virt_text = { { text, "DiagnosticError" } },
    virt_text_pos = "overlay",
  })
end

function M.clear_chat_list_error()
  local chat_list = require("chat-nvim.ui.chat_list")
  local buf = chat_list.get_bufnr()
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end

  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
end

return M
