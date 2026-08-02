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
    local added, changed, needs_reorder = state.append_messages(chat_id, params.messages)

    -- Computed outside the branches below on purpose: a push can both add messages and
    -- change the banner, and folding this into the append branch would leave the banner
    -- stuck on stale wording. An `unavailable` push carries neither adds nor changes.
    -- A push that carries no `banner` key is not saying the banner is gone, it is saying
    -- nothing about it — the event-tail path (F9) pushes only the messages that changed.
    -- JSON null decodes to vim.NIL, not nil, so a real nil is the only way a key can be
    -- absent, and an explicit null still means "there is no banner" and must clear it.
    local banner_changed = false
    if params.banner ~= nil then
      local new_banner = state.norm(params.banner)
      banner_changed = state.banners[chat_id] ~= new_banner
      if banner_changed then state.banners[chat_id] = new_banner end
    end

    if chat_id == state.current_chat then
      if #changed > 0 or needs_reorder or banner_changed then
        -- A changed message sits somewhere in the middle of the buffer, so appending
        -- cannot express it — redraw.
        if needs_reorder then state.sort_messages(chat_id) end
        messages_ui.render_full(chat_id, { keep_cursor = true })
        -- Only a pure live arrival moves the read watermark: an edit to an old message,
        -- or history arriving from behind, is not the user reading anything new.
        if #added > 0 and #changed == 0 and not needs_reorder then
          state.mark_read(chat_id)
        end
      elseif #added > 0 then
        messages_ui.append(chat_id, added)
        state.mark_read(chat_id)
      end
    end

    if #changed > 0 or #added > 0 or banner_changed then
      chat_list.render()
    end
    if #added > 0 then log_latency(params) end
    return
  end

  if uri == "chat://chats" and params.chats then
    state.update_chats(params.chats, params.truncation_banner)
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

-- The single production point for the delivery notice. F63: the stream is only a latency
-- hint, so this says "slower", never "disconnected" — and the number comes from the sidecar
-- (CHATMUX_POLL_MS), because a hardcoded 15 starts lying the moment anyone changes it.
local function refresh_delivery_notice()
  -- The persistent notice is a single slot (notify.lua:13). While the connection itself
  -- is not healthy, that slot belongs to whoever is describing the connection —
  -- daemon_unreachable owns it, reconnecting and disconnected are mid-flight. The
  -- supervisor's reopen timer, the poll timer and recoverSession are three independent
  -- clocks, so "sse_restored arrives while connection is still daemon_unreachable" is
  -- routine, not exotic. Speaking here would wipe a message that is still true.
  --
  -- The invariant, stated once: the delivery notice only speaks when the connection is
  -- healthy. Every other state re-enters through the `connected` branch below, which
  -- calls this again once state.connection is already "connected".
  if state.connection ~= "connected" then return end

  if state.delivery == "polling" then
    local secs = math.floor((state.poll_ms or 15000) / 1000)
    require("chat-nvim.ui.notify").set_persistent_notice(
      "low-latency push is off — still delivering, up to " .. secs .. "s behind")
  else
    require("chat-nvim.ui.notify").clear_persistent_notice()
  end
end

local function handle_notification(method, params)
  if method == "connected" then
    state.connection = "connected"   -- MUST come first: the guard above reads it
    refresh_delivery_notice()
    check_adapter_status()
  elseif method == "sse_degraded" then
    state.delivery = "polling"
    state.poll_ms = params.poll_ms or 15000
    refresh_delivery_notice()
  elseif method == "sse_restored" then
    state.delivery = "push"
    refresh_delivery_notice()
  elseif method == "daemon_unreachable" then
    state.connection = "daemon_unreachable"
    local notify = require("chat-nvim.ui.notify")
    -- F27: only what is known to be true. The sidecar reached the socket layer and found
    -- nothing listening — that is a statement about the daemon, not about the network,
    -- the config, or how long it will last.
    notify.set_persistent_notice("chatmux daemon is not running")
  elseif method == "disconnected" then
    state.connection = "disconnected"
    local notify = require("chat-nvim.ui.notify")
    local reason = params.reason or "unknown"
    if reason:match("sidecar exited") then
      notify.show_error_in_chat_list("Disconnected: chatmux daemon may not be running")
    else
      notify.show_error_in_chat_list("Disconnected: " .. reason)
    end
  elseif method == "reconnecting" then
    state.connection = "reconnecting"
  elseif method == "reconnect_failed" then
    state.connection = "disconnected"
    local notify = require("chat-nvim.ui.notify")
    -- F27/F34: only what is known to be true. The sidecar cannot see whether the daemon is
    -- down, misconfigured, or just slow — it only knows its own retries ran out.
    notify.show_error_in_chat_list(
      "Lost the chatmux daemon and could not reconnect — is it running?"
    )
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
    ensure_sidecar()
    require("chat-nvim.ui.search").open(cmd.args ~= "" and cmd.args or nil)
  end, { nargs = "*", desc = "Search the current chat's full history in the local DB" })

  vim.api.nvim_create_user_command("ChatClose", function()
    M.close_ui()
  end, { desc = "Close chatmux UI" })
end

-- Both entry points open the chat-list pane, so both have to fill it. Shared rather than
-- copied: :ChatOpen opening a pane that no one had taught to fetch is exactly how it came
-- to display "No chats found" beside 143 chats.
local function fetch_chats()
  local chat_list = require("chat-nvim.ui.chat_list")

  sidecar.send("list_chats", {}, function(result, err)
    vim.schedule(function()
      if err then
        local notify = require("chat-nvim.ui.notify")
        notify.show_error_in_chat_list("list_chats: " .. tostring(err))
        return
      end
      state.update_chats(result.chats, result.truncation_banner)
      chat_list.render()
    end)
  end)
end

function M._chat_list()
  ensure_sidecar()

  local chat_list = require("chat-nvim.ui.chat_list")
  chat_list.open()

  fetch_chats()
end

function M._chat_open(chat_id)
  ensure_sidecar()
  local messages_ui = require("chat-nvim.ui.messages")
  messages_ui.open(chat_id)
  fetch_chats()
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
      state.update_chats(result.chats, result.truncation_banner)
      local chat_list = require("chat-nvim.ui.chat_list")
      chat_list.render()
    end)
  end)
end

function M.statusline()
  -- The four *connection* states live in one variable and only one can hold at a time, so
  -- their relative order is readability. Delivery is a second, orthogonal variable (F63
  -- decision D), and where it sits relative to them IS precedence — see the comment above
  -- the [polling] branch. Reordering that one is a behaviour change, not a tidy-up;
  -- scripts/f63-degraded-signal-check.lua asserts it.
  if state.connection == "daemon_unreachable" then
    -- Distinct from [reconnecting] on purpose: that one means "the sidecar is alive and
    -- working on it, back in a moment"; this one can last until someone starts the daemon.
    return "[daemon offline]"
  end
  -- Checked before "disconnected" because recovery is a distinct state, not a milder outage:
  -- the sidecar is alive and working on it, so telling the user to go check the daemon would
  -- be wrong (F27 — the status line does not lie).
  if state.connection == "reconnecting" then
    return "[reconnecting]"
  end
  if state.connection == "disconnected" then
    return "[disconnected]"
  end
  -- Deliberately after all three connection states: delivery is orthogonal to connection
  -- (F63 decision D), and when the daemon is gone "push is degraded" is noise — [daemon
  -- offline] is what the user needs. Only a healthy connection gets to say [polling].
  if state.delivery == "polling" then
    return "[polling]"
  end
  local count = state.unread_count()
  if count > 0 then
    return "💬 " .. count
  end
  return ""
end

-- Exported for scripts/f9-banner-guard-check.lua only: the banner guard's failure mode is
-- a line quietly disappearing, which nothing else can assert from outside.
M._test_handle_resource_updated = handle_resource_updated

-- Exported for scripts/f60-offline-signal-check.lua only: F55's failure was a state being
-- right while nothing showed it, so the check has to drive the handler from outside.
M._test_handle_notification = handle_notification

return M
