local state = require("chat-nvim.state")
local sidecar = require("chat-nvim.sidecar")
local keymap = require("chat-nvim.keymap")

local M = {}

local bufnr = nil
local winnr = nil

--- How many hits core is asked for. The panel says so when there are more, rather than
--- pretending the page is the whole answer.
local PAGE = 50

--- 20 × the messages pager's 50 = 1000 messages walked backwards. Past that the honest
--- answer is "I stopped looking", not more waiting.
local MAX_PAGES = 20

M._results = {}

--- Collapse a core snippet into one display line.
--- The FTS branch wraps hits in <b>…</b>; the LIKE branch (query shorter than 3
--- characters) returns the whole content_text with no markup and possibly newlines.
--- Both arrive here, so neither markup nor brevity may be assumed.
function M._clean_snippet(snippet, width)
  local s = (snippet or ""):gsub("</?b>", ""):gsub("%s*\n%s*", " ")
  -- Byte-safe truncation for CJK: sub() on bytes would split a multi-byte character.
  if vim.fn.strchars(s) > width then s = vim.fn.strcharpart(s, 0, width) end
  return s
end

--- The status line occupies row 1, so result n lives on row n+1. Kept as a pair of
--- functions rather than an inline offset: the offset appearing in two places is how
--- <CR> ends up jumping to the neighbouring hit, which reads as "it worked".
function M._set_results(results)
  M._results = results or {}
end

function M._result_at(line)
  return M._results[line - 1]
end

--------------------------------------------------------------------------------
-- Panel
--------------------------------------------------------------------------------

local function is_open()
  return winnr ~= nil and vim.api.nvim_win_is_valid(winnr)
end

local function set_lines(lines)
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end
  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modifiable = false
end

function M.close()
  if is_open() then
    vim.api.nvim_win_close(winnr, true)
  end
  winnr = nil
  bufnr = nil
  local messages = require("chat-nvim.ui.messages")
  local msg_win = messages.get_winnr()
  if msg_win and vim.api.nvim_win_is_valid(msg_win) then
    vim.api.nvim_set_current_win(msg_win)
  end
end

--- Every status this panel reports goes through here — into the buffer, never the cmdline.
--- The cmdline writers are banned outright (docs/ui-conventions.md): several of them in a
--- row stops on "Press ENTER", which locks the editor.
function M.set_status(text)
  M._status = text
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end
  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, 1, false, { text })
  vim.bo[bufnr].modifiable = false
end

function M.get_status()
  return M._status or ""
end

local function open_window(title, height)
  bufnr = vim.api.nvim_create_buf(false, true)
  vim.bo[bufnr].buftype = "nofile"
  vim.bo[bufnr].bufhidden = "wipe"
  vim.bo[bufnr].swapfile = false
  vim.bo[bufnr].modifiable = false

  local width = math.floor(vim.o.columns * 0.8)
  winnr = vim.api.nvim_open_win(bufnr, true, {
    relative = "editor",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
    style = "minimal",
    border = "rounded",
    title = " search: " .. title .. " ",
    title_pos = "center",
  })
  vim.wo[winnr].wrap = false
  vim.wo[winnr].cursorline = true

  keymap.set_search_keymaps(bufnr)

  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = bufnr,
    callback = function()
      bufnr = nil
      winnr = nil
    end,
  })
  return width
end

local function format_time(timestamp)
  if not timestamp or timestamp == vim.NIL then return "??:??" end
  return os.date("%H:%M", math.floor(timestamp / 1000))
end

local function render(query, results, total)
  local width = open_window(query, math.min(#results + 2, 20))

  local status = ("%d / %d 筆命中（本聊天室）"):format(#results, total or #results)
  if (total or 0) > #results then
    status = status .. ("（僅顯示前 %d）"):format(#results)
  end

  local lines = { status }
  for _, r in ipairs(results) do
    local msg = r.message or {}
    local sender = state.norm(msg.sender_name) or "unknown"
    local chat_name = state.norm(r.chat_name) or "?"
    local prefix = ("%s  %s  %s — "):format(chat_name, format_time(msg.timestamp), sender)
    local snippet_width = math.max(10, width - vim.fn.strchars(prefix) - 2)
    table.insert(lines, prefix .. M._clean_snippet(r.snippet, snippet_width))
  end
  set_lines(lines)
  M._status = status
  M._set_results(results)

  if #results > 0 and is_open() then
    pcall(vim.api.nvim_win_set_cursor, winnr, { 2, 0 })
  end
end

local function run(query)
  local chat = state.current_chat
  if not chat then
    -- Panel-in-a-panel rather than a message: there is no cmdline path out of here.
    render(query, {}, 0)
    M.set_status("請先開一個聊天室再搜尋。")
    return
  end

  sidecar.send("search_messages", { query = query, chat_id = chat, limit = PAGE },
    function(result, err)
      vim.schedule(function()
        if err or not result then
          render(query, {}, 0)
          M.set_status("搜尋失敗：" .. tostring(err))
          return
        end
        render(query, result.results or {}, state.norm(result.total) or 0)
      end)
    end)
end

function M.open(query)
  if is_open() then M.close() end
  if query and query ~= "" then
    run(query)
    return
  end
  -- vim.ui.input respects whatever the user configured (usually a float); it is not the
  -- cmdline echo path the conventions ban.
  vim.ui.input({ prompt = "搜尋：" }, function(input)
    if not input or vim.trim(input) == "" then return end
    run(vim.trim(input))
  end)
end

--------------------------------------------------------------------------------
-- Jump
--------------------------------------------------------------------------------

--- Walk backwards through history until the message is in the buffer, then park on it.
---
--- deps is the test seam: {load_older, max_pages}. Production passes nothing.
function M._jump_to_id(chat_id, msg_id, deps)
  local messages = require("chat-nvim.ui.messages")
  local load_older = (deps and deps.load_older)
    or function(c, done) messages.load_older(c, done) end
  local cap = (deps and deps.max_pages) or MAX_PAGES
  local pages = 0

  local function step()
    if messages.focus_message(chat_id, msg_id) then
      M.close()
      return
    end
    -- false means "the local DB has no more"; nil means "never asked", which is a reason
    -- to ask. Only an explicit false is an answer (same rule as `[`). And what it answers
    -- is a question about this machine: the platform may well hold more, so the wording
    -- below must not turn "I ran out" into "it does not exist".
    if state.has_more[chat_id] == false then
      M.set_status("無法定位：本機已載完這間聊天室，仍未到達該訊息。更舊的訊息是否存在於平台端未知。")
      return
    end
    if pages >= cap then
      M.set_status(("無法定位：已往回載入 %d 頁仍未到達該訊息；本機 DB 仍有更舊訊息。"):format(cap))
      return
    end
    pages = pages + 1
    M.set_status(("定位中…已往回載入 %d 頁"):format(pages))
    load_older(chat_id, function() vim.schedule(step) end)
  end

  step()
end

function M.jump(line)
  local result = M._result_at(line)
  if not result then return end     -- the status line, or past the last result
  local chat = state.current_chat
  if result.message.chat_id ~= chat then
    -- Cross-chat search is deliberately out of scope this round; the panel only ever
    -- lists the current chat, so this is a guard, not a user-facing path.
    M.set_status("這筆不在當前聊天室，本版不支援跨室跳轉。")
    return
  end
  M._jump_to_id(chat, result.message.id)
end

return M
