local state = require("chat-nvim.state")

local M = {}

--- What `o` will act on. Images are deliberately absent: they are already on screen via
--- image.lua, and handing an image's bytes to an external viewer would be a second, worse
--- way to look at something the reader can already see.
local OPENABLE = { video = true, audio = true, file = true }

local ns = vim.api.nvim_create_namespace("chat_nvim_attachment")

--- How long to wait for the bytes. Core gives its adapter 30s and then answers "gone", so
--- anything at or below that turns a correct answer into a made-up failure.
local FETCH_TIMEOUT_SEC = 60

--- Test seam, same shape as image.set_renderer: a headless check swaps the real opener for
--- one that only records what it was asked to open.
local function default_opener(path)
  vim.ui.open(path)
end

local opener = default_opener

function M.set_opener(fn)
  opener = fn or default_opener
end

--- Every status this path reports is virtual text on the message's own line. The cmdline
--- writers are banned outright (docs/ui-conventions.md): several in a row stops on
--- "Press ENTER", which locks the editor.
function M._set_status(buf, row, text)
  M._status = text
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  pcall(vim.api.nvim_buf_set_extmark, buf, ns, row, 0, {
    virt_text = { { "  " .. text, "DiagnosticInfo" } },
    virt_text_pos = "eol",
  })
end

function M._clear_status(buf)
  M._status = nil
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
end

function M.last_status()
  return M._status or ""
end

--- The same discipline state.in_flight enforces for `[`: a fetch is in the air, so a second
--- press is a no-op. Without it, holding `o` launches the external program once per press
--- and the virtual-text updates overwrite each other. Keyed by message id, so two different
--- attachments can still be fetched concurrently.
local in_flight = {}

function M.open_at_cursor()
  local chat = state.current_chat
  local messages = require("chat-nvim.ui.messages")
  local win = messages.get_winnr()
  if not chat or not win or not vim.api.nvim_win_is_valid(win) then return end

  local row = vim.api.nvim_win_get_cursor(win)[1] - 1   -- msg_rows is 0-based
  local rows = state.msg_rows[chat]
  if not rows then return end

  -- The cursor is usually on a body line, not the header. Walk up to the nearest header
  -- row: that is the message the reader is looking at. A version that only reads the exact
  -- row under the cursor passes every header-row test and does nothing in real use.
  local id
  local at = row
  while at >= 0 do
    if rows.by_row[at] then
      id = rows.by_row[at]
      row = at
      break
    end
    at = at - 1
  end
  if not id then return end

  local msg = state.find_message(chat, id)
  if not msg or not OPENABLE[state.norm(msg.content_type)] then
    M._set_status(messages.get_bufnr(), row, "這行沒有可開啟的附件")
    return
  end

  if in_flight[id] then return end
  in_flight[id] = true

  M._set_status(messages.get_bufnr(), row, "取得中…")
  require("chat-nvim.sidecar").send(
    "fetch_media",
    { chat_id = chat, message_id = id },
    function(result, err)
      vim.schedule(function()
        -- Cleared on every exit, including the error one: a stale `true` disables `o` for
        -- that attachment for the rest of the session, with no error shown anywhere (R6).
        in_flight[id] = nil
        if err or not result then
          M._set_status(messages.get_bufnr(), row, "附件取得失敗")
          return
        end
        if result.path and result.path ~= vim.NIL then
          M._clear_status(messages.get_bufnr())
          opener(result.path)
          return
        end
        -- Wording comes from the sidecar; Lua must not compose a second version of it.
        M._set_status(messages.get_bufnr(), row, state.norm(result.text) or "附件無法取得")
      end)
    end,
    -- Longer than core's own 30s adapter deadline, so even its "gone" answer arrives.
    -- The default 10s is shorter than a Telegram refetch takes (14–15s, Phase 0.3), which
    -- turned every uncached Telegram attachment into "附件取得失敗" regardless of outcome.
    { timeout_sec = FETCH_TIMEOUT_SEC }
  )
end

return M
