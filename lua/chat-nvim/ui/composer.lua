local state = require("chat-nvim.state")
local sidecar = require("chat-nvim.sidecar")
local keymap = require("chat-nvim.keymap")

local M = {}

local bufnr = nil
local winnr = nil

local function close()
  if winnr and vim.api.nvim_win_is_valid(winnr) then
    vim.api.nvim_win_close(winnr, true)
  end
  winnr = nil
  bufnr = nil
end

local function send()
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end
  if not state.current_chat then
    close()
    return
  end

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local text = table.concat(lines, "\n")
  text = vim.trim(text)

  if text == "" then
    close()
    return
  end

  local chat_id = state.current_chat
  close()

  sidecar.send("send_message", { chat_id = chat_id, text = text }, function(result, err)
    vim.schedule(function()
      local messages_ui = require("chat-nvim.ui.messages")
      local notify = require("chat-nvim.ui.notify")
      if err then
        notify.send_feedback("Send failed: " .. tostring(err), true)
      else
        notify.send_feedback("Sent", false)
      end
    end)
  end)
end

function M.open()
  if not state.current_chat then return end

  -- Close existing composer if open
  if winnr and vim.api.nvim_win_is_valid(winnr) then
    close()
    return
  end

  local messages_ui = require("chat-nvim.ui.messages")
  local msg_win = messages_ui.get_winnr()
  if not msg_win or not vim.api.nvim_win_is_valid(msg_win) then return end

  local msg_width = vim.api.nvim_win_get_width(msg_win)
  local msg_height = vim.api.nvim_win_get_height(msg_win)

  local width = math.floor(msg_width * 0.8)
  local height = 5
  local col = math.floor((msg_width - width) / 2)
  local row = msg_height - height - 2

  bufnr = vim.api.nvim_create_buf(false, true)
  vim.bo[bufnr].buftype = "nofile"
  vim.bo[bufnr].bufhidden = "wipe"

  winnr = vim.api.nvim_open_win(bufnr, true, {
    relative = "win",
    win = msg_win,
    width = width,
    height = height,
    row = row,
    col = col,
    style = "minimal",
    border = "rounded",
    title = " compose ",
    title_pos = "center",
  })

  vim.wo[winnr].wrap = true
  vim.wo[winnr].cursorline = false

  keymap.set_composer_keymaps(bufnr, send, close)

  vim.cmd("startinsert")

  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = bufnr,
    callback = function()
      bufnr = nil
      winnr = nil
    end,
  })
end

function M.close()
  close()
end

return M
