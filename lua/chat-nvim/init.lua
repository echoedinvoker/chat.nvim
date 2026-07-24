local sidecar = require("chat-nvim.sidecar")
local state = require("chat-nvim.state")

local M = {}

M.config = {
  socket_path = vim.env.CHATMUX_SOCKET
    or (vim.env.HOME .. "/.local/share/chatmux/chatmux.sock"),
}

local function log_latency(params)
  local sidecar_received = params.sidecar_received_at
  local msg_ts = params.msg_timestamp
  if not sidecar_received or sidecar_received == vim.NIL then return end

  local sec, usec = vim.loop.gettimeofday()
  local lua_rendered_at = sec * 1000 + math.floor(usec / 1000)
  local ipc_ms = lua_rendered_at - sidecar_received

  local line = string.format(
    "%s | ipc=%dms",
    os.date("%Y-%m-%d %H:%M:%S"),
    ipc_ms
  )
  if msg_ts and msg_ts ~= vim.NIL then
    local chain_ms = sidecar_received - msg_ts
    line = line .. string.format(" | chain=%dms | total=%dms", chain_ms, chain_ms + ipc_ms)
  end

  pcall(vim.fn.writefile, { line }, "/tmp/chat-nvim-latency.log", "a")
end

local function handle_resource_updated(params)
  local uri = params.uri
  if not uri then return end

  local chat_list = require("chat-nvim.ui.chat_list")
  local messages_ui = require("chat-nvim.ui.messages")

  local chat_id = uri:match("^chat://chats/([^/]+)/messages")
  if chat_id and params.messages then
    local added = state.append_messages(chat_id, params.messages)
    if #added > 0 then
      if chat_id == state.current_chat then
        messages_ui.append(chat_id, added)
        state.mark_read(chat_id)
      end
      chat_list.render()
      log_latency(params)
    end
    return
  end

  if uri == "chat://chats" and params.chats then
    state.update_chats(params.chats)
    chat_list.render()
    return
  end
end

local function check_adapter_status()
  local sc = require("chat-nvim.sidecar")
  sc.send("get_status", {}, function(result, err)
    vim.schedule(function()
      if err then return end
      if not result or not result.daemon then return end

      local adapters = result.daemon.adapters
      if type(adapters) ~= "table" then return end

      for _, adapter in pairs(adapters) do
        if adapter.status == "disconnected" or adapter.status == "error" then
          local handle = io.popen("pgrep -f line-tui 2>/dev/null")
          local pgrep_out = handle and handle:read("*a") or ""
          if handle then handle:close() end

          if pgrep_out:match("%d") then
            local notify = require("chat-nvim.ui.notify")
            notify.show_error_in_chat_list("line-tui is still running — stop it first")
          end
          break
        end
      end
    end)
  end)
end

local function handle_notification(method, params)
  if method == "connected" then
    state.connection = "connected"
    check_adapter_status()
  elseif method == "disconnected" then
    state.connection = "disconnected"
    local notify = require("chat-nvim.ui.notify")
    local reason = params.reason or "unknown"
    if reason:match("sidecar exited") then
      notify.show_error_in_chat_list("Disconnected: chatmux daemon may not be running")
    else
      notify.show_error_in_chat_list("Disconnected: " .. reason)
    end
  elseif method == "resource_updated" then
    handle_resource_updated(params)
  elseif method == "error" then
    local notify = require("chat-nvim.ui.notify")
    notify.show_error_in_chat_list("sidecar: " .. (params.message or "unknown"))
  end
end

local function ensure_sidecar()
  if sidecar.is_running() then return end
  sidecar.set_notification_handler(function(method, params)
    vim.schedule(function()
      handle_notification(method, params)
    end)
  end)
  sidecar.start()
end

function M.setup(opts)
  opts = opts or {}
  M.config = vim.tbl_deep_extend("force", M.config, opts)

  state.init()

  vim.api.nvim_create_user_command("ChatList", function()
    M._chat_list()
  end, { desc = "Open chatmux chat list" })

  vim.api.nvim_create_user_command("ChatOpen", function(cmd)
    M._chat_open(cmd.args)
  end, { nargs = 1, desc = "Open chatmux chat by ID" })

  vim.api.nvim_create_user_command("ChatSend", function(cmd)
    M._chat_send(cmd.args)
  end, { nargs = 1, desc = "Send message to current chat" })

  vim.api.nvim_create_user_command("ChatSearch", function(cmd)
    M._chat_search(cmd.args)
  end, { nargs = 1, desc = "Search chatmux messages" })

  vim.api.nvim_create_user_command("ChatClose", function()
    M.close_ui()
  end, { desc = "Close chatmux UI" })
end

function M._chat_list()
  ensure_sidecar()

  local chat_list = require("chat-nvim.ui.chat_list")
  chat_list.open()

  sidecar.send("list_chats", {}, function(result, err)
    vim.schedule(function()
      if err then
        local notify = require("chat-nvim.ui.notify")
        notify.show_error_in_chat_list("list_chats: " .. tostring(err))
        return
      end
      state.update_chats(result.chats)
      chat_list.render()
    end)
  end)
end

function M._chat_open(chat_id)
  ensure_sidecar()
  local messages_ui = require("chat-nvim.ui.messages")
  messages_ui.open(chat_id)
end

function M._chat_send(text)
  if not state.current_chat then return end
  ensure_sidecar()
  local notify = require("chat-nvim.ui.notify")
  sidecar.send("send_message", { chat_id = state.current_chat, text = text }, function(result, err)
    vim.schedule(function()
      if err then
        notify.send_feedback("Send failed: " .. tostring(err), true)
      else
        notify.send_feedback("Sent", false)
      end
    end)
  end)
end

function M._chat_search(query)
  ensure_sidecar()
  sidecar.send("search_messages", { query = query }, function(result, err)
    vim.schedule(function()
      if err then return end
      if not result or not result.messages then return end
      -- Show search results in quickfix
      local items = {}
      for _, msg in ipairs(result.messages) do
        local sender = msg.sender_name or "unknown"
        if sender == vim.NIL then sender = "unknown" end
        local text_preview = msg.text or ""
        if text_preview == vim.NIL then text_preview = "[media]" end
        text_preview = text_preview:gsub("\n", " "):sub(1, 80)
        table.insert(items, {
          text = sender .. ": " .. text_preview,
          lnum = 0,
        })
      end
      vim.fn.setqflist(items, "r")
      if #items > 0 then
        vim.cmd("copen")
      end
    end)
  end)
end

function M.close_ui()
  local messages_ui = require("chat-nvim.ui.messages")
  local chat_list = require("chat-nvim.ui.chat_list")

  if state.current_chat then
    sidecar.send("close_chat", { chat_id = state.current_chat })
    state.current_chat = nil
  end

  messages_ui.close()
  chat_list.close()
  sidecar.stop()
  state.reset()
end

function M.refresh_chats()
  sidecar.send("list_chats", {}, function(result, err)
    vim.schedule(function()
      if err then return end
      state.update_chats(result.chats)
      local chat_list = require("chat-nvim.ui.chat_list")
      chat_list.render()
    end)
  end)
end

function M.statusline()
  if state.connection == "disconnected" then
    return "[disconnected]"
  end
  local count = state.unread_count()
  if count > 0 then
    return "💬 " .. count
  end
  return ""
end

return M
