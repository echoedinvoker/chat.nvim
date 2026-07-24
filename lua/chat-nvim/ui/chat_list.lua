local state = require("chat-nvim.state")
local keymap = require("chat-nvim.keymap")

local M = {}

local bufnr = nil
local winnr = nil
local WIDTH = 30

function M.render()
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end

  local lines = {}
  local hl_ranges = {}

  if #state.chats == 0 then
    table.insert(lines, "  No chats found")
  else
    for i, chat in ipairs(state.chats) do
      local name = chat.name
      if name == nil or name == vim.NIL then
        name = chat.id or "unknown"
      end
      local marker = ""
      if state.has_unread(chat.id) then
        marker = " [●]"
        table.insert(hl_ranges, { line = i - 1, col = #name, len = #marker })
      end
      table.insert(lines, name .. marker)
    end
  end

  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modifiable = false

  local ns = vim.api.nvim_create_namespace("chat_nvim_unread")
  vim.api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
  for _, hl in ipairs(hl_ranges) do
    vim.api.nvim_buf_add_highlight(bufnr, ns, "DiagnosticInfo", hl.line, hl.col, hl.col + hl.len)
  end
end

function M.open()
  if bufnr and vim.api.nvim_buf_is_valid(bufnr) then
    if winnr and vim.api.nvim_win_is_valid(winnr) then
      vim.api.nvim_set_current_win(winnr)
      return
    end
  end

  vim.cmd("topleft vnew")
  winnr = vim.api.nvim_get_current_win()
  bufnr = vim.api.nvim_get_current_buf()

  vim.api.nvim_win_set_width(winnr, WIDTH)

  vim.bo[bufnr].buftype = "nofile"
  vim.bo[bufnr].bufhidden = "wipe"
  vim.bo[bufnr].swapfile = false
  vim.bo[bufnr].modifiable = false
  vim.api.nvim_buf_set_name(bufnr, "chat-nvim://chats")

  vim.wo[winnr].number = false
  vim.wo[winnr].relativenumber = false
  vim.wo[winnr].signcolumn = "no"
  vim.wo[winnr].winfixwidth = true
  vim.wo[winnr].wrap = false
  vim.wo[winnr].cursorline = true

  keymap.set_chat_list_keymaps(bufnr)

  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = bufnr,
    callback = function()
      bufnr = nil
      winnr = nil
    end,
  })

  M.render()
end

function M.close()
  if winnr and vim.api.nvim_win_is_valid(winnr) then
    vim.api.nvim_win_close(winnr, true)
  end
  winnr = nil
  bufnr = nil
end

function M.is_open()
  return bufnr ~= nil and vim.api.nvim_buf_is_valid(bufnr)
end

function M.get_bufnr()
  return bufnr
end

return M
