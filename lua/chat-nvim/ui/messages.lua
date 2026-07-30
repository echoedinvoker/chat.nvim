local state = require("chat-nvim.state")
local sidecar = require("chat-nvim.sidecar")
local keymap = require("chat-nvim.keymap")
local image = require("chat-nvim.ui.image")

local M = {}

local bufnr = nil
local winnr = nil

--- How many messages one page holds, both on open and on every `[`. Core's own default is
--- 20, and not passing a limit at all is why a chat only ever existed as its newest 20.
local PAGE_SIZE = 50

local function format_time(timestamp)
  if not timestamp or timestamp == vim.NIL then return "??:??" end
  local secs = math.floor(timestamp / 1000)
  return os.date("%H:%M", secs)
end

--- Returns the lines, plus the 0-based row each message's header landed on.
---
--- The rows come back from here rather than being recounted later because this loop is
--- the only place that knows how many lines a message took — a multi-line body and the
--- rows reserved for an image both change the answer, and a second counter written
--- against the same rules is a second thing that can drift out of step with them.
local function format_messages(messages)
  local lines = {}
  local rows = {}
  for _, msg in ipairs(messages) do
    local sender = msg.sender_name
    if sender == nil or sender == vim.NIL then
      sender = "unknown"
    end
    if msg.is_self then sender = "Me" end
    local time = format_time(msg.timestamp)

    table.insert(rows, #lines)   -- 0-based row of the header we are about to write
    table.insert(lines, "## " .. sender .. "  " .. time)
    local text = msg.text
    if msg.retracted_at and msg.retracted_at ~= vim.NIL then
      -- Italic so a withdrawn message reads as absence, not as something the sender typed.
      text = "_[訊息已收回]_"
    end
    -- There is no `text == nil` branch here on purpose. The sidecar's `toMessage` sets
    -- `text` on every path, so a second placeholder format lived here only to drift from
    -- the first one — it read `msg.sticker_id`, a field the sidecar has never produced.
    -- Verified at runtime, not by reading: 101 probe lines across five chats, zero with
    -- a null text (Phase 1.2). Placeholders have one origin: sidecar/src/mcp-client.ts.
    for line in (text .. "\n"):gmatch("([^\n]*)\n") do
      table.insert(lines, line)
    end
    -- F35: no blank lines are reserved for an image here, on purpose. image.nvim already
    -- reserves the space as virtual lines (image.lua:124), sized from the height it
    -- actually rendered at — reserving real lines as well made every image sit above a
    -- second, equally tall gap. A first version did exactly that, on the theory that
    -- virtual lines would break `[`'s preserve_view because they do not count towards the
    -- buffer's line delta. They do not need to: topline and lnum are buffer line numbers,
    -- so restoring topline + delta lands on the same content, and virtual lines ride along
    -- with the extmark of the line they belong to.
    table.insert(lines, "")
  end
  return lines, rows
end

--- opts.keep_cursor: stay where the reader was instead of jumping to the newest message.
--- Used when a redraw is caused by an edit or retraction somewhere above, which is not a
--- reason to yank the reader down to the bottom.
---
--- opts.preserve_view: same intent, but for a redraw that *prepends* lines. keep_cursor
--- restores the saved position verbatim, which is only correct while line numbers keep
--- meaning the same content; after prepending N lines the old line L holds what used to be
--- at L-N, so restoring L lands the reader somewhere else and the screen visibly jumps.
--- This path compensates with the buffer's own line-count delta.
function M.render_full(chat_id, opts)
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end

  local keep_cursor = opts and opts.keep_cursor
  local preserve_view = opts and opts.preserve_view
  local win_valid = winnr and vim.api.nvim_win_is_valid(winnr)
  local saved = nil
  if keep_cursor and win_valid then
    saved = vim.api.nvim_win_get_cursor(winnr)
  end

  local view, before_count = nil, nil
  if preserve_view and win_valid then
    before_count = vim.api.nvim_buf_line_count(bufnr)
    -- winsaveview acts on the *current* window. `[` is a buffer-local map so the messages
    -- window is usually current, but render_full is also reached from other paths.
    vim.api.nvim_win_call(winnr, function()
      view = vim.fn.winsaveview()
    end)
  end

  local messages = state.messages[chat_id] or {}
  local lines, msg_rows = format_messages(messages)

  -- Header is 0, 2 or 3 lines depending on paging state, which is why the preserve_view
  -- delta above is measured on the buffer rather than counted from the prepended messages.
  local header = {}
  if state.banners[chat_id] then
    table.insert(header, state.banners[chat_id])
  end
  if state.older_hint[chat_id] then
    table.insert(header, state.older_hint[chat_id])
  end
  local header_offset = 0
  if #header > 0 then
    table.insert(header, "")
    header_offset = #header
    lines = vim.list_extend(header, lines)
  end

  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modifiable = false

  -- Placed after the lines are in: image.nvim anchors on an extmark, and an extmark set
  -- against rows that are about to be replaced wholesale would be pointing at nothing.
  -- The offset is the banner/hint block, which format_messages knows nothing about.
  for i = 1, #msg_rows do
    msg_rows[i] = msg_rows[i] + header_offset
  end
  image.apply(image.plan(messages, msg_rows), bufnr, winnr)

  if not win_valid then return end

  if view then
    -- The delta has to be measured on the buffer, not derived from how many messages were
    -- prepended: the banner and hint lines above the messages appear and disappear with the
    -- paging state, so they shift the reader's line just as much as the messages do.
    local delta = vim.api.nvim_buf_line_count(bufnr) - before_count
    view.lnum = view.lnum + delta
    view.topline = view.topline + delta
    vim.api.nvim_win_call(winnr, function()
      -- Out of range should not be reachable, but an error here would kill the callback
      -- that still has to clear in_flight.
      pcall(vim.fn.winrestview, view)
    end)
    return
  end

  if saved then
    -- A retraction shortens the buffer, so the old line may no longer exist.
    pcall(vim.api.nvim_win_set_cursor, winnr, saved)
    return
  end

  -- Scroll to bottom on initial load
  local count = vim.api.nvim_buf_line_count(bufnr)
  vim.api.nvim_win_set_cursor(winnr, { count, 0 })
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

--- One rung of the paging ladder. `before` is a timestamp and core's filter is a strict
--- `timestamp < before`, so the rung is chosen by what it costs to be wrong:
---   rung 1 (before = oldest + 1, i.e. `timestamp <= oldest`) can never skip a message that
---     shares the oldest timestamp; it re-fetches those, and append_messages drops them by id.
---   rung 2 (before = oldest, strict) is only used when rung 1 returned nothing new, which
---     means the whole page shares one timestamp. It guarantees forward progress at the cost
---     of the rest of that tie — being stuck forever is worse than losing a few (R1/R2).
--- is_retry exists so rung 2 can never trigger rung 3: no recursion, at most two requests.
local function request_older(chat_id, before, is_retry)
  state.in_flight[chat_id] = true
  sidecar.send("read_messages", {
    chat_id = chat_id,
    limit = PAGE_SIZE,
    before = before,
  }, function(result, err)
    vim.schedule(function()
      -- Cleared on every exit, including the error one: a stale `true` disables `[` for
      -- this chat with no error shown anywhere (R6).
      state.in_flight[chat_id] = false
      if err or not result then return end

      local added = state.append_messages(chat_id, result.messages or {})
      state.sort_messages(chat_id)
      state.has_more[chat_id] = result.has_more
      state.older_hint[chat_id] = state.norm(result.older_hint)
      state.banners[chat_id] = state.norm(result.banner)

      if #added == 0 and result.has_more and not is_retry then
        -- before - 1 drops the inclusive +1 back to a strict `<`.
        request_older(chat_id, before - 1, true)
        return
      end

      M.render_full(chat_id, { preserve_view = true })
    end)
  end)
end

--- Load one page of older messages above what is already in the buffer.
function M.load_older(chat_id)
  if not chat_id then return end
  if state.in_flight[chat_id] then return end
  -- nil means "never asked", which is a reason to ask. Only an explicit false is an answer.
  if state.has_more[chat_id] == false then return end

  local msgs = state.messages[chat_id]
  local oldest = msgs and msgs[1] and msgs[1].timestamp
  if not oldest or oldest == vim.NIL then return end

  request_older(chat_id, oldest + 1, false)
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
  sidecar.send("read_messages", { chat_id = chat_id, limit = PAGE_SIZE }, function(result, err)
    vim.schedule(function()
      if err then return end
      state.update_messages(chat_id, result.messages)
      state.banners[chat_id] = state.norm(result.banner)
      -- Without these two the first `[` has nothing to go on: has_more nil would let it
      -- fire blindly, and the top line would stay silent about there being more above.
      state.has_more[chat_id] = result.has_more
      state.older_hint[chat_id] = state.norm(result.older_hint)
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
