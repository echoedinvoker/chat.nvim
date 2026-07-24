local M = {}

local ns = vim.api.nvim_create_namespace("chat_nvim_notify")

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
