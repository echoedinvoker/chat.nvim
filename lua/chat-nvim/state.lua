local M = {}

M.chats = {}           -- Chat[] from list_chats
M.messages = {}        -- {[chat_id] = Message[]}
-- Four mutually exclusive states in one variable, last write wins. "reconnecting" is the
-- sidecar rebuilding a session against a daemon that is alive; "daemon_unreachable" is the
-- daemon not being there at all, which can last until someone starts it (F60).
M.connection = "disconnected" -- "connected" | "reconnecting" | "daemon_unreachable" | "disconnected"
-- Delivery is deliberately *not* a fifth value of M.connection. When the daemon dies, "the
-- daemon is gone" and "the SSE stream will not open" are true at the same time; in one
-- last-write-wins variable they would overwrite each other and which one survived would
-- depend on the arrival order of two independent notifications (F63 decision D). The stream
-- is only a latency hint — the poll below is what makes delivery correct — so its death means
-- "slower", never "disconnected".
M.delivery = "push"    -- "push" | "polling"
-- The poll interval the sidecar actually runs with (CHATMUX_POLL_MS), sent along with
-- sse_degraded so the notice can state a real number instead of a hardcoded 15.
M.poll_ms = 15000
M.current_chat = nil   -- chat_id or nil
M.last_read = {}       -- {[chat_id] = timestamp} client-side unread tracking
M.banners = {}         -- {[chat_id] = string} history notice shown above the messages

-- Paging backwards through history. `has_more` comes from core (which fetches limit+1 and
-- reports whether it had to trim), never inferred here: a client-side guess like "the page
-- came back full, so there is probably more" is wrong on the exact-multiple boundary.
-- nil means "not asked yet" and permits a request; only an explicit false blocks one.
M.has_more = {}        -- {[chat_id] = boolean} is there anything older in the local DB?
M.in_flight = {}       -- {[chat_id] = boolean} is a load-older request in the air?
M.older_hint = {}      -- {[chat_id] = string} top status line; wording decided by sidecar

-- Where each loaded message currently sits in the messages buffer, written by render_full
-- from the rows format_messages returned. Search's jump and the attachment keymap both
-- need to go from a message id to a line and back, and neither may recount: the format
-- loop is the only place that knows how many lines a message took.
M.msg_rows = {}        -- {[chat_id] = {by_id = {[msg_id] = row}, by_row = {[row] = msg_id}}}

-- There is deliberately no cached-oldest-timestamp table here: the oldest loaded timestamp
-- is M.messages[chat_id][1].timestamp (update_messages reverses to oldest-first and
-- sort_messages keeps it ascending). A second copy would be a second truth, and nothing
-- reads it that cannot read the list.

local DATA_DIR = vim.fn.stdpath("data") .. "/chat-nvim"
local READ_STATE_FILE = DATA_DIR .. "/read-state.json"

local function ensure_data_dir()
  vim.fn.mkdir(DATA_DIR, "p")
end

local function load_read_state()
  local f = io.open(READ_STATE_FILE, "r")
  if not f then return end
  local content = f:read("*a")
  f:close()
  local ok, data = pcall(vim.json.decode, content)
  if ok and type(data) == "table" then
    M.last_read = data
  end
end

local function save_read_state()
  ensure_data_dir()
  local f = io.open(READ_STATE_FILE, "w")
  if not f then return end
  f:write(vim.json.encode(M.last_read))
  f:close()
end

function M.init()
  load_read_state()
end

--- `banner` is nil unless the list came back short of the daemon's own total.
--- Passed through norm(): JSON null decodes to vim.NIL, which is truthy, so storing
--- it raw would make the warning render on every complete list.
function M.update_chats(chats, banner)
  M.chats = chats or {}
  M.chat_list_banner = M.norm(banner)
end

function M.update_messages(chat_id, messages)
  local msgs = messages or {}
  -- API returns newest-first; reverse to chronological (oldest-first) for display
  local reversed = {}
  for i = #msgs, 1, -1 do
    table.insert(reversed, msgs[i])
  end
  M.messages[chat_id] = reversed
end

--- JSON null decodes to vim.NIL, which is neither nil nor comparable to a number.
local function norm(v)
  if v == nil or v == vim.NIL then return nil end
  return v
end

M.norm = norm

--- Has this message changed in a way the buffer must show?
---
--- F43: media is compared explicitly. Before this, a photo going pending → ready was noticed
--- only because the placeholder text happened to change with it ("[圖片載入中…]" → "[image]")
--- — the state layer never looked at media at all. That coincidence is not something to
--- build a redraw on, and F44 weakened it further by appending captions to both wordings.
local function media_of(m)
  local media = norm(m.media)
  if media == nil then return nil, nil end
  return norm(media.state), norm(media.path)
end

local function differs(old, new)
  local old_state, old_path = media_of(old)
  local new_state, new_path = media_of(new)
  return norm(old.text) ~= norm(new.text)
    or norm(old.edited_at) ~= norm(new.edited_at)
    or norm(old.retracted_at) ~= norm(new.retracted_at)
    or old_state ~= new_state
    or old_path ~= new_path
end

function M.append_messages(chat_id, new_messages)
  if not M.messages[chat_id] then
    M.messages[chat_id] = {}
  end

  local index = {}
  for i, m in ipairs(M.messages[chat_id]) do
    index[m.id] = i
  end

  local existing = M.messages[chat_id]
  local newest_before = existing[#existing] and existing[#existing].timestamp

  local added = {}
  local changed = {}
  local needs_reorder = false
  for _, m in ipairs(new_messages) do
    local at = index[m.id]
    if at == nil then
      -- Backfilled history is "unseen" to the client just like a live message, but it
      -- belongs above the existing ones. Appending it blindly inverts the timeline.
      if newest_before and m.timestamp < newest_before then
        needs_reorder = true
      end
      table.insert(M.messages[chat_id], m)
      table.insert(added, m)
      index[m.id] = #M.messages[chat_id]
    elseif differs(M.messages[chat_id][at], m) then
      -- Edits and retractions arrive as the same id with new content. Skipping known ids
      -- (the old behaviour) is why core-side changes never reached the buffer.
      M.messages[chat_id][at] = m
      table.insert(changed, m)
    end
  end

  return added, changed, needs_reorder
end

--- Numeric when the platform id is a number, lexicographic otherwise: Telegram ids are
--- variable-length integers, where "10000" sorts before "9999" as a string.
local function id_rank(id)
  local tail = tostring(id):match("[^:]+$") or ""
  return tonumber(tail), tail
end

--- table.sort is not stable, and mark_read reads the last element as "the newest" — so
--- same-millisecond messages need a deterministic tiebreaker or the read watermark drifts.
function M.sort_messages(chat_id)
  local msgs = M.messages[chat_id]
  if not msgs then return end

  table.sort(msgs, function(a, b)
    if a.timestamp ~= b.timestamp then return a.timestamp < b.timestamp end
    local an, as = id_rank(a.id)
    local bn, bs = id_rank(b.id)
    if an and bn then return an < bn end
    return as < bs
  end)
end

--- The loaded message with this id, or nil. A linear scan on purpose: the list is one
--- chat's loaded page range, and a second index keyed by id would be a second thing to keep
--- in step with append_messages, update_messages and sort_messages.
function M.find_message(chat_id, msg_id)
  for _, m in ipairs(M.messages[chat_id] or {}) do
    if m.id == msg_id then return m end
  end
  return nil
end

function M.mark_read(chat_id)
  local msgs = M.messages[chat_id]
  if msgs and #msgs > 0 then
    local latest = msgs[#msgs]
    M.last_read[chat_id] = latest.timestamp
  else
    M.last_read[chat_id] = vim.loop.gettimeofday() * 1000
  end
  save_read_state()
end

function M.has_unread(chat_id)
  local chat = nil
  for _, c in ipairs(M.chats) do
    if c.id == chat_id then
      chat = c
      break
    end
  end
  if not chat or not chat.last_message_time then return false end
  return chat.last_message_time > (M.last_read[chat_id] or 0)
end

function M.unread_count()
  local count = 0
  for _, chat in ipairs(M.chats) do
    if M.has_unread(chat.id) then
      count = count + 1
    end
  end
  return count
end

function M.reset()
  M.chats = {}
  M.messages = {}
  M.banners = {}
  -- Clearing in_flight matters most: a request that was in the air when the connection
  -- dropped never runs its callback, so a stale `true` would silently disable `[` for that
  -- chat forever, with no error anywhere.
  M.has_more = {}
  M.in_flight = {}
  M.older_hint = {}
  M.msg_rows = {}
  M.connection = "disconnected"
  -- Reopening the UI in the same Neovim session starts a fresh sidecar whose sseFailures is
  -- back at 0, so it will never send sse_restored. A delivery left at "polling" would keep
  -- the statusline saying [polling] until some later real degradation happened to clear it —
  -- the same "the screen is lying" shape this round exists to remove.
  M.delivery = "push"
  M.poll_ms = 15000
  M.current_chat = nil
end

return M
