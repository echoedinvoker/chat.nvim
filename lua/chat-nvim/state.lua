local M = {}

M.chats = {}           -- Chat[] from list_chats
M.messages = {}        -- {[chat_id] = Message[]}
M.connection = "disconnected" -- "connected" | "disconnected"
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
local function differs(old, new)
  return norm(old.text) ~= norm(new.text)
    or norm(old.edited_at) ~= norm(new.edited_at)
    or norm(old.retracted_at) ~= norm(new.retracted_at)
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
  M.connection = "disconnected"
  M.current_chat = nil
end

return M
