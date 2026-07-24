local M = {}

M.chats = {}           -- Chat[] from list_chats
M.messages = {}        -- {[chat_id] = Message[]}
M.connection = "disconnected" -- "connected" | "disconnected"
M.current_chat = nil   -- chat_id or nil
M.last_read = {}       -- {[chat_id] = timestamp} client-side unread tracking

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

function M.update_chats(chats)
  M.chats = chats or {}
end

function M.update_messages(chat_id, messages)
  M.messages[chat_id] = messages or {}
end

function M.append_messages(chat_id, new_messages)
  if not M.messages[chat_id] then
    M.messages[chat_id] = {}
  end

  local existing = {}
  for _, m in ipairs(M.messages[chat_id]) do
    existing[m.id] = true
  end

  local added = {}
  for _, m in ipairs(new_messages) do
    if not existing[m.id] then
      table.insert(M.messages[chat_id], m)
      table.insert(added, m)
      existing[m.id] = true
    end
  end

  return added
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
  M.connection = "disconnected"
  M.current_chat = nil
end

return M
