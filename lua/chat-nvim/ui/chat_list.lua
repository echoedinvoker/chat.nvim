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
      -- An empty string is as unusable as a missing one: Telegram reports blank display
      -- names for accounts with no title set, and those rendered as bare blank rows the
      -- user could not tell apart or aim at.
      local name = chat.name
      if name == nil or name == vim.NIL or name:match("^%s*$") then
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

  -- Trailing, because the truncation happens at the tail and the top of the list is
  -- where the user actually works. <CR> is bounded by #state.chats, so this extra line
  -- is a safe no-op to land on.
  local banner = state.chat_list_banner
  if banner then
    table.insert(lines, banner)
    table.insert(hl_ranges, { line = #lines - 1, col = 0, len = #banner, hl = "DiagnosticWarn" })
  end

  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modifiable = false

  local ns = vim.api.nvim_create_namespace("chat_nvim_unread")
  vim.api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
  for _, hl in ipairs(hl_ranges) do
    vim.api.nvim_buf_add_highlight(bufnr, ns, hl.hl or "DiagnosticInfo", hl.line, hl.col, hl.col + hl.len)
  end

  -- F55: the set_lines above replaces every line, and extmarks go with the lines they were
  -- anchored to. A standing notice ("the daemon is not running") has to be put back, or it
  -- disappears on the next redraw and reads as the outage having ended.
  require("chat-nvim.ui.notify").reapply_notice()
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
