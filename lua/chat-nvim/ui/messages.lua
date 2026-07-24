local state = require("chat-nvim.state")
local sidecar = require("chat-nvim.sidecar")
local keymap = require("chat-nvim.keymap")

local M = {}

local bufnr = nil
local winnr = nil

local function format_time(timestamp)
  if not timestamp or timestamp == vim.NIL then return "??:??" end
  local secs = math.floor(timestamp / 1000)
  return os.date("%H:%M", secs)
end

local function format_messages(messages)
  local lines = {}
  for _, msg in ipairs(messages) do
    local sender = msg.sender_name
    if sender == nil or sender == vim.NIL then
      sender = "unknown"
    end
    if msg.is_self then sender = "Me" end
    local time = format_time(msg.timestamp)

    table.insert(lines, "## " .. sender .. "  " .. time)
    local text = msg.text
    if text == nil or text == vim.NIL then
      if msg.sticker_id and msg.sticker_id ~= vim.NIL then
        text = "[sticker:" .. tostring(msg.sticker_id) .. "]"
      else
        text = "[image]"
      end
    end
    for line in (text .. "\n"):gmatch("([^\n]*)\n") do
      table.insert(lines, line)
    end
    table.insert(lines, "")
  end
  return lines
end

function M.render_full(chat_id)
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end

  local messages = state.messages[chat_id] or {}
  local lines = format_messages(messages)

  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modifiable = false

  -- Scroll to bottom on initial load
  if winnr and vim.api.nvim_win_is_valid(winnr) then
    local count = vim.api.nvim_buf_line_count(bufnr)
    vim.api.nvim_win_set_cursor(winnr, { count, 0 })
  end
end

function M.append(chat_id, new_messages)
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end
  if state.current_chat ~= chat_id then return end
  if #new_messages == 0 then return end

  local win = winnr
  if not win or not vim.api.nvim_win_is_valid(win) then return end

  local cursor = vim.api.nvim_win_get_cursor(win)
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  local at_bottom = cursor[1] >= line_count - 2

  local new_lines = format_messages(new_messages)

  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, -1, -1, false, new_lines)
  vim.bo[bufnr].modifiable = false

  if at_bottom then
    local new_count = vim.api.nvim_buf_line_count(bufnr)
    vim.api.nvim_win_set_cursor(win, { new_count, 0 })
  else
    pcall(vim.api.nvim_win_set_cursor, win, cursor)
  end
end

function M.open(chat_id)
  state.current_chat = chat_id

  local chat_list = require("chat-nvim.ui.chat_list")
  if not chat_list.is_open() then
    chat_list.open()
  end

  if bufnr and vim.api.nvim_buf_is_valid(bufnr) then
    if winnr and vim.api.nvim_win_is_valid(winnr) then
      vim.api.nvim_set_current_win(winnr)
    end
  else
    -- Create messages buffer to the right of chat list
    vim.cmd("wincmd l")
    local cur_buf = vim.api.nvim_get_current_buf()
    if cur_buf == chat_list.get_bufnr() then
      vim.cmd("vnew")
    else
      -- Already in a non-chat-list window, reuse it
      vim.cmd("enew")
    end

    winnr = vim.api.nvim_get_current_win()
    bufnr = vim.api.nvim_get_current_buf()

    vim.bo[bufnr].buftype = "nofile"
    vim.bo[bufnr].bufhidden = "wipe"
    vim.bo[bufnr].swapfile = false
    vim.bo[bufnr].modifiable = false
    vim.bo[bufnr].filetype = "markdown"

    vim.wo[winnr].number = false
    vim.wo[winnr].relativenumber = false
    vim.wo[winnr].signcolumn = "no"
    vim.wo[winnr].wrap = true

    keymap.set_messages_keymaps(bufnr)

    vim.api.nvim_create_autocmd("BufWipeout", {
      buffer = bufnr,
      callback = function()
        bufnr = nil
        winnr = nil
      end,
    })
  end

  -- Set buffer name to reflect current chat
  pcall(vim.api.nvim_buf_set_name, bufnr, "chat-nvim://messages/" .. chat_id)

  -- Fetch messages
  sidecar.send("read_messages", { chat_id = chat_id }, function(result, err)
    vim.schedule(function()
      if err then return end
      state.update_messages(chat_id, result.messages)
      state.mark_read(chat_id)
      M.render_full(chat_id)
      -- Refresh chat list to update unread markers
      chat_list.render()
    end)
  end)
end

function M.close()
  if state.current_chat then
    sidecar.send("close_chat", { chat_id = state.current_chat })
    state.current_chat = nil
  end

  if winnr and vim.api.nvim_win_is_valid(winnr) then
    vim.api.nvim_win_close(winnr, true)
  end
  winnr = nil
  bufnr = nil

  -- Focus back to chat list
  local chat_list = require("chat-nvim.ui.chat_list")
  if chat_list.is_open() then
    vim.cmd("wincmd h")
  end
end

function M.is_open()
  return bufnr ~= nil and vim.api.nvim_buf_is_valid(bufnr)
end

function M.get_bufnr()
  return bufnr
end

function M.get_winnr()
  return winnr
end

return M
