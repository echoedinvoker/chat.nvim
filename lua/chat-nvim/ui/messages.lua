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

--- Park the view at the newest message with the space reserved under it on screen too.
---
--- Moving the cursor to the last buffer line is not enough. image.nvim reserves an image's
--- height as virt_lines hanging off an extmark, and virt_lines are not buffer lines: nvim
--- will happily call the last line visible while the picture below it runs off under the
--- statusline. `specs` is image.plan's output — `spec.row` is a 0-based buffer row and
--- `spec.height` is in terminal cells.
---
--- Two timings have to come out the same, because the reservation and this call race:
---   * magick already came back — the virt_lines exist, nvim_win_text_height counts them
---   * magick is still working — the height exists only in the spec, so it is added here
--- Handling only the first is handling only the case where the image was already cached.
---
--- The height a spec is worth here is `spec.height`, which holds only while image.lua calls
--- from_file without `render_offset_top` or `overlap` — image.nvim reserves
--- get_reserved_lines(height, render_offset_top, overlap) rows, which equals height only in
--- that case (checked against image.nvim@88351f1f). Add either option to image.lua and this
--- arithmetic goes quietly wrong with no assertion to catch it.
local function scroll_to_bottom(win, bufnr, specs)
  local count = vim.api.nvim_buf_line_count(bufnr)
  local win_h = vim.api.nvim_win_get_height(win)

  -- Which specs have not had their virt_lines written yet. nvim_win_text_height can only
  -- see the ones that exist, so these are the ones this function has to account for.
  local pending = {}   -- 0-based row -> height
  for _, s in ipairs(specs) do
    pending[s.row] = s.height
  end
  for _, m in ipairs(vim.api.nvim_buf_get_extmarks(bufnr, -1, 0, -1, { details = true })) do
    local row, det = m[2], m[4]
    if det and det.virt_lines and #det.virt_lines > 0 and pending[row] then
      pending[row] = nil
    end
  end

  -- The smallest topline whose screen rows down to the last line still fit. Searched from
  -- the bottom up so the loop is bounded by the window height, not by the buffer's length,
  -- and stopped at the first overflow: one line further up is one line off the bottom.
  local best = count
  for t = count, 1, -1 do
    local ok, th = pcall(vim.api.nvim_win_text_height, win,
      { start_row = t - 1, end_row = count - 1 })
    if not ok then break end
    local extra = 0
    for row, h in pairs(pending) do
      -- spec rows are 0-based, toplines are 1-based.
      if row + 1 >= t then extra = extra + h end
    end
    if th.all + extra > win_h then break end
    best = t
  end

  vim.api.nvim_win_call(win, function()
    vim.fn.winrestview({ topline = best, lnum = count, col = 0 })
  end)
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

  -- Built from the same array format_messages returned, not recounted. That loop is the
  -- only place that knows how many lines a message took (multi-line bodies, reserved
  -- image rows) — a second counter written against the same rules is a second thing to
  -- drift out of step with them.
  local by_id, by_row = {}, {}
  for i, msg in ipairs(messages) do
    if msg.id and msg.id ~= vim.NIL then
      by_id[msg.id] = msg_rows[i]
      by_row[msg_rows[i]] = msg.id
    end
  end
  state.msg_rows[chat_id] = { by_id = by_id, by_row = by_row }

  local specs = image.plan(messages, msg_rows)
  image.apply(specs, bufnr, winnr)

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
  else
    -- Scroll to bottom on initial load
    vim.api.nvim_win_set_cursor(winnr, { vim.api.nvim_buf_line_count(bufnr), 0 })
  end

  -- Both branches above can land on the last line, and neither of them can see the virtual
  -- lines hanging under it — a keep_cursor redraw of a reader already at the bottom is what
  -- every late-media arrival looks like. So the compensation is attached to where the view
  -- ended up, not to which branch put it there. The preserve_view branch returned above on
  -- purpose: its whole job is to leave the window alone.
  if vim.api.nvim_win_get_cursor(winnr)[1] == vim.api.nvim_buf_line_count(bufnr) then
    scroll_to_bottom(winnr, bufnr, specs)
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

  if at_bottom then
    -- F66: appending lines cannot draw a picture. render_full is the only place that calls
    -- image.plan/image.apply, so an arrival that took this path used to show up as
    -- `[sticker:…]` with nothing under it — the symptom that got filed as a sidecar bug.
    --
    -- The images cannot be planned locally instead: image.apply clears everything live and
    -- redraws exactly what it is handed (image.lua:92-95), so passing only the new
    -- message's specs would wipe every picture already on screen. Rewriting the buffer from
    -- state is the cheaper of the two, and state already holds the new messages —
    -- init.lua runs state.append_messages before it calls here.
    --
    -- This gives up append's "only touch the new lines" advantage. Deliberate: render_full
    -- is already what every `changed` push runs, and a picture that is never drawn is not
    -- an optimisation.
    M.render_full(chat_id)
    return
  end

  local new_lines = format_messages(new_messages)

  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, -1, -1, false, new_lines)
  vim.bo[bufnr].modifiable = false

  -- The reader is scrolled up reading something; an arrival is not a reason to move them.
  pcall(vim.api.nvim_win_set_cursor, win, cursor)
end

--- One rung of the paging ladder. `before` is a timestamp and core's filter is a strict
--- `timestamp < before`, so the rung is chosen by what it costs to be wrong:
---   rung 1 (before = oldest + 1, i.e. `timestamp <= oldest`) can never skip a message that
---     shares the oldest timestamp; it re-fetches those, and append_messages drops them by id.
---   rung 2 (before = oldest, strict) is only used when rung 1 returned nothing new, which
---     means the whole page shares one timestamp. It guarantees forward progress at the cost
---     of the rest of that tie — being stuck forever is worse than losing a few (R1/R2).
--- is_retry exists so rung 2 can never trigger rung 3: no recursion, at most two requests.
---
--- on_done is answered on every exit and exactly once, the same discipline in_flight is
--- cleared under and for the same reason: the search jump pages back in a loop driven by
--- this callback, so a path that forgets it stalls the loop forever with nothing on screen
--- to say so. Rung 2 hands it down rather than calling it — one ladder, one answer.
local function request_older(chat_id, before, is_retry, on_done)
  local function done()
    if on_done then on_done() end
  end

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
      if err or not result then
        done()
        return
      end

      local added = state.append_messages(chat_id, result.messages or {})
      state.sort_messages(chat_id)
      state.has_more[chat_id] = result.has_more
      state.older_hint[chat_id] = state.norm(result.older_hint)
      state.banners[chat_id] = state.norm(result.banner)

      if #added == 0 and result.has_more and not is_retry then
        -- before - 1 drops the inclusive +1 back to a strict `<`.
        request_older(chat_id, before - 1, true, on_done)
        return
      end

      M.render_full(chat_id, { preserve_view = true })
      -- After the redraw, so a caller that reacts to this can already read msg_rows.
      done()
    end)
  end)
end

--- Load one page of older messages above what is already in the buffer.
---
--- on_done is optional and fires once the buffer reflects the outcome — including the
--- outcomes where nothing was loaded. A refusal that stays silent is indistinguishable
--- from a request still in the air.
function M.load_older(chat_id, on_done)
  local function done()
    if on_done then on_done() end
  end

  if not chat_id then return done() end
  if state.in_flight[chat_id] then return done() end
  -- nil means "never asked", which is a reason to ask. Only an explicit false is an answer.
  if state.has_more[chat_id] == false then return done() end

  local msgs = state.messages[chat_id]
  local oldest = msgs and msgs[1] and msgs[1].timestamp
  if not oldest or oldest == vim.NIL then return done() end

  request_older(chat_id, oldest + 1, false, on_done)
end

--- Park the cursor on a message that is already in the buffer.
--- Returns false if the id is not loaded — the caller pages back and retries.
function M.focus_message(chat_id, msg_id)
  local rows = state.msg_rows[chat_id]
  local row = rows and rows.by_id[msg_id]
  if not row then return false end
  if not winnr or not vim.api.nvim_win_is_valid(winnr) then return false end
  -- rows are 0-based, cursor lines are 1-based.
  local ok = pcall(vim.api.nvim_win_set_cursor, winnr, { row + 1, 0 })
  if not ok then return false end
  vim.api.nvim_win_call(winnr, function() vim.cmd("normal! zz") end)
  return true
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
