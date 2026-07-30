-- Mechanical check for the image pipeline's Lua half (F35): does each ready image get
-- planned at the right row, do the other three states get nothing, and does a prepended
-- page move every image by exactly as much as it moved the text?
--
--   nvim --headless -l scripts/f35-image-spec-check.lua
--
-- Both the sidecar and image.nvim are stubbed, so this asserts the Lua layer alone: no
-- daemon, no ImageMagick, no terminal. It exists because "the images look like they are
-- in the right places" is not something a screenshot can settle — an image anchored one
-- row off, or one that fails to move when a page is prepended, looks entirely plausible
-- until you scroll.
--
-- What this does NOT assert: whether the picture is legible, sized sensibly, or pleasant
-- to read next to the text. That is the gestalt judgement, and it belongs to a person
-- (Step 5.5), not to this script and not to a model looking at a screenshot.
--
-- Output goes to stdout via io.write. print/vim.notify would queue up messages and hit
-- "Press ENTER", which hangs a headless run.

vim.opt.runtimepath:append(vim.fn.getcwd())

vim.o.lines = 24
vim.o.columns = 80

--------------------------------------------------------------------------------
-- Stub sidecar (same shape as scripts/f34-anchor-check.lua)
--------------------------------------------------------------------------------

local requests = {}
local responder = function() return nil end

package.loaded["chat-nvim.sidecar"] = {
  send = function(method, params, cb)
    table.insert(requests, { method = method, params = params })
    if not cb then return end
    local result = responder(method, params, #requests)
    vim.schedule(function() cb(result, nil) end)
  end,
  start = function() end,
  stop = function() end,
  is_running = function() return true end,
  set_notification_handler = function() end,
}

local state = require("chat-nvim.state")
local messages = require("chat-nvim.ui.messages")
local image = require("chat-nvim.ui.image")

--------------------------------------------------------------------------------
-- Fake renderer: records what it was asked to draw, draws nothing.
--------------------------------------------------------------------------------

local drawn = {}      -- spec id -> spec, as of the last apply
local cleared = 0

image.set_renderer({
  create = function(spec)
    return { spec = spec }
  end,
  render = function(img)
    drawn[img.spec.id] = img.spec
  end,
  clear = function()
    cleared = cleared + 1
  end,
})

--------------------------------------------------------------------------------
-- Assertions
--------------------------------------------------------------------------------

local failures = 0

local function check(n, label, expected, actual)
  if expected ~= actual then
    io.write(("FAIL: %d %s expected=%s actual=%s\n")
      :format(n, label, vim.inspect(expected), vim.inspect(actual)))
    failures = failures + 1
    return false
  end
  io.write(("ok  : %d %s = %s\n"):format(n, label, vim.inspect(actual)))
  return true
end

local function check_true(n, label, cond)
  return check(n, label, true, cond and true or false)
end

local function msg(i, ts, overrides)
  local m = {
    id = "line:m" .. i,
    chat_id = "line:c",
    sender_name = "S" .. (i % 3),
    timestamp = ts,
    text = "message body " .. i,
    is_self = false,
    content_type = "text",
  }
  for k, v in pairs(overrides or {}) do m[k] = v end
  return m
end

local function newest_first(list)
  local out = {}
  for i = #list, 1, -1 do table.insert(out, list[i]) end
  return out
end

local function buf_has(bufnr, needle)
  for _, line in ipairs(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)) do
    if line:find(needle, 1, true) then return true end
  end
  return false
end

--------------------------------------------------------------------------------
-- Fixture: one message of each state, in a chat with a second page behind it.
--------------------------------------------------------------------------------

local CHAT = "line:cIMG"

local page1 = {
  msg(1, 1000, {
    content_type = "sticker",
    text = "[sticker:5145/7432559]",
    media = { state = "ready", path = "/cache/line/sticker/7432559.png" },
  }),
  msg(2, 2000, {
    content_type = "image",
    text = "[圖片載入中…]",
    media = { state = "pending" },
  }),
  msg(3, 3000, {
    content_type = "image",
    text = "[圖片已不存在於 LINE]",
    media = { state = "gone" },
  }),
  msg(4, 4000, { content_type = "video", text = "[video]" }),
  msg(5, 5000, {
    content_type = "image",
    text = "[image]",
    media = { state = "ready", path = "/cache/line/msg/624795090909135379.jpg" },
  }),
}

local page2 = {}
for i = 10, 19 do
  table.insert(page2, msg(i, i))
end

responder = function(_, params)
  if params.before == nil then
    return { messages = newest_first(page1), has_more = true,
             oldest_timestamp = 1000, banner = nil,
             older_hint = "↑ 還有更舊的訊息（按 [ 載入 50 筆）" }
  end
  return { messages = newest_first(page2), has_more = false,
           oldest_timestamp = 10, banner = nil,
           older_hint = "── 已載入本機全部；更舊的是否存在未知 ──" }
end

messages.open(CHAT)
vim.wait(2000, function()
  return state.messages[CHAT] ~= nil and #state.messages[CHAT] == #page1
end)

local bufnr = vim.api.nvim_get_current_buf()

--------------------------------------------------------------------------------
-- Group A: the four states
--------------------------------------------------------------------------------

check(1, "only the two ready messages are planned", 2, vim.tbl_count(drawn))

local sticker = drawn["line:m1"]
check_true(2, "the sticker got a spec", sticker ~= nil)

if sticker then
  check(3, "sticker path is the cached file core handed over",
    "/cache/line/sticker/7432559.png", sticker.path)
  check(4, "sticker height is the sticker height, not the photo one",
    image.height_for("sticker"), sticker.height)

  -- The header row is found in the buffer rather than assumed, so this asserts the
  -- placement rule (image sits one row under its header) and not my arithmetic.
  local header_row = nil
  for i, line in ipairs(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)) do
    if line:find("^## ") then header_row = i - 1 break end
  end
  check(5, "sticker sits one row below its header", header_row + 1, sticker.row)
end

check_true(6, "the photo got a spec too", drawn["line:m5"] ~= nil)
check(7, "pending is not drawn", nil, drawn["line:m2"])
check(8, "gone is not drawn", nil, drawn["line:m3"])
check(9, "video is not drawn", nil, drawn["line:m4"])

-- The wording is the sidecar's, and Lua must be printing it verbatim.
check_true(10, "pending says it is loading", buf_has(bufnr, "[圖片載入中…]"))
check_true(11, "gone says LINE deleted it, not nothing", buf_has(bufnr, "[圖片已不存在於 LINE]"))
check_true(12, "video keeps its existing label", buf_has(bufnr, "[video]"))

--------------------------------------------------------------------------------
-- Group B: R9 — prepending a page must move images exactly as far as text
--------------------------------------------------------------------------------

local before_rows = {}
for id, spec in pairs(drawn) do before_rows[id] = spec.row end
local before_count = vim.api.nvim_buf_line_count(bufnr)
local open_requests = #requests

messages.load_older(CHAT)
vim.wait(2000, function()
  return #requests > open_requests and not state.in_flight[CHAT]
end)
vim.wait(200, function() return false end)

local delta = vim.api.nvim_buf_line_count(bufnr) - before_count
check_true(13, "the prepended page actually made the buffer longer", delta > 0)

local all_moved_together = true
for id, was in pairs(before_rows) do
  local now = drawn[id] and drawn[id].row
  if now ~= was + delta then
    io.write(("     %s: was=%s now=%s expected=%s\n")
      :format(id, tostring(was), tostring(now), tostring(was + delta)))
    all_moved_together = false
  end
end
check_true(14, "every image moved by exactly the buffer's line delta", all_moved_together)

check_true(15, "the previous draw was cleared before the new one", cleared > 0)

--------------------------------------------------------------------------------
-- Group C: R11 — no message-area output that could trigger "Press ENTER"
--------------------------------------------------------------------------------

local noisy = {}
for _, path in ipairs({ "lua/chat-nvim/ui/image.lua", "lua/chat-nvim/ui/messages.lua" }) do
  local fh = io.open(path, "r")
  if fh then
    local n = 0
    for line in fh:lines() do
      n = n + 1
      -- Comments mentioning these by name are fine; calls are not.
      local code = line:gsub("%-%-.*$", "")
      if code:find("vim%.notify") or code:find("nvim_echo") or code:find("[^%w_]print%s*%(")
         or code:find("^print%s*%(") then
        table.insert(noisy, path .. ":" .. n)
      end
    end
    fh:close()
  end
end
if #noisy > 0 then io.write("     " .. table.concat(noisy, ", ") .. "\n") end
check(16, "no notify/echo/print in the image path", 0, #noisy)

--------------------------------------------------------------------------------

if failures > 0 then
  io.write(("FAILED: %d of 16\n"):format(failures))
  os.exit(1)
end
io.write("ALL PASS: 16/16\n")
os.exit(0)
