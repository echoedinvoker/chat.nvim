-- Mechanical check for F58: when the view is parked at the newest message, the virtual
-- lines that image.nvim reserves under that message have to be inside the window too.
--
--   nvim --headless -l scripts/f58-viewport-check.lua
--
-- "The cursor is on the last buffer line" is not the same claim as "the last picture is on
-- screen". image.nvim reserves its space as virt_lines hanging off an extmark, and those
-- are not buffer lines: nvim_buf_line_count cannot see them, so a scroll computed from it
-- lands the bottom third of the image under the statusline. On 2026-08-01 that was about a
-- third of a sticker; on 2026-08-02 a 3.67 MB photo overflowed by 11 terminal rows with
-- text_height.all = 74 against a window of 62 — 60 of those 74 rows were filler.
--
-- The two timings are asserted separately because they fail differently:
--   A  virt_lines already written  — the height is measurable, nvim_win_text_height sees it
--   B  virt_lines not written yet  — magick is still running, so the reserved height exists
--      only in the spec, and any scroll that trusts the buffer alone is computed too low
-- A fix that only handles A is a fix that only works when the image was already cached.
--
-- Output goes to stdout via io.write. print/vim.notify would queue up messages and hit
-- "Press ENTER", which hangs a headless run.

vim.opt.runtimepath:append(vim.fn.getcwd())

vim.o.lines = 24
vim.o.columns = 80

--------------------------------------------------------------------------------
-- Stub sidecar (same shape as scripts/f35-image-spec-check.lua)
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
-- Assertions
--------------------------------------------------------------------------------

local failures = 0

local function check(label, ok, extra)
  io.write((ok and "ok   " or "FAIL ") .. label .. (extra and ("  " .. extra) or "") .. "\n")
  if not ok then failures = failures + 1 end
end

--------------------------------------------------------------------------------
-- Stub renderer. with_virt decides whether the reserved space actually exists yet,
-- which is the whole difference between timing A and timing B.
--------------------------------------------------------------------------------

local ns = vim.api.nvim_create_namespace("f58-check")

local function stub(with_virt)
  return {
    create = function(spec, buf)
      local mark = nil
      if with_virt then
        local vl = {}
        for _ = 1, spec.height do vl[#vl + 1] = { { " ", "Normal" } } end
        mark = vim.api.nvim_buf_set_extmark(buf, ns, spec.row, 0, { virt_lines = vl })
      end
      return { spec = spec, buf = buf, mark = mark }
    end,
    render = function() end,
    -- Deleting the extmark matters: image.apply clears before it draws, and a leftover
    -- mark from the previous scenario would keep reserving rows in the same buffer.
    clear = function(img)
      if img.mark then pcall(vim.api.nvim_buf_del_extmark, img.buf, ns, img.mark) end
    end,
  }
end

--------------------------------------------------------------------------------
-- Fixture
--------------------------------------------------------------------------------

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

--- n plain messages, then whatever `last` is (nil means the chat ends on text).
--- `base` offsets both the id and the timestamp: two pages of the same chat must not reuse
--- ids, or state.append_messages drops the older page as already-seen and `[` looks broken.
local function page(n, last, base)
  local out = {}
  base = base or 0
  for i = 1, n do table.insert(out, msg(base + i, (base + i) * 1000)) end
  if last then table.insert(out, last) end
  return out
end

local function photo(i, ts)
  return msg(i, ts, {
    content_type = "image",
    text = "[image]",
    media = { state = "ready", path = "/cache/line/msg/" .. i .. ".jpg" },
  })
end

local function newest_first(list)
  local out = {}
  for i = #list, 1, -1 do table.insert(out, list[i]) end
  return out
end

local pages = {}   -- chat id -> { first = {...}, older = {...} or nil }

responder = function(_, params)
  local p = pages[params.chat_id] or { first = {} }
  if params.before == nil then
    return {
      messages = newest_first(p.first),
      has_more = p.older ~= nil,
      oldest_timestamp = p.first[1] and p.first[1].timestamp or 0,
      banner = nil,
      older_hint = nil,
    }
  end
  return {
    messages = newest_first(p.older or {}),
    has_more = false,
    oldest_timestamp = 1,
    banner = nil,
    older_hint = nil,
  }
end

--- Opens a chat in a *fresh* window and waits until its page is in state.
---
--- The close() is not tidiness. Every scenario reuses one window otherwise, and a window
--- keeps its topline: nvim only scrolls when the cursor would fall off screen, so a
--- scenario that inherits a topline scrolled far enough for the *previous* fixture can
--- pass without the code under test doing anything. That is how timing B first came up
--- green here — inherited topline 24, which happened to leave exactly enough room.
local function open(chat)
  local want = #(pages[chat].first)
  if messages.is_open() then
    messages.close()
    vim.wait(50, function() return false end)
  end
  messages.open(chat)
  vim.wait(2000, function()
    return state.messages[chat] ~= nil and #state.messages[chat] == want
  end)
  vim.wait(50, function() return false end)
  return messages.get_bufnr(), messages.get_winnr()
end

--- Screen rows from the current topline to the last buffer line, plus any height that is
--- reserved in a spec but not yet written as virt_lines (nvim_win_text_height can only see
--- what exists). This is the quantity that must not exceed the window height.
local function rows_to_bottom(win, buf, pending_extra)
  local count = vim.api.nvim_buf_line_count(buf)
  local view = vim.api.nvim_win_call(win, function() return vim.fn.winsaveview() end)
  local th = vim.api.nvim_win_text_height(win, { start_row = view.topline - 1, end_row = count - 1 })
  return th.all + (pending_extra or 0), vim.api.nvim_win_get_height(win), view.topline
end

local function fits(win, buf, pending_extra)
  local used, win_h, topline = rows_to_bottom(win, buf, pending_extra)
  return used <= win_h,
    ("used=" .. used .. " win_h=" .. win_h .. " topline=" .. topline)
end

--- True when the window is scrolled no further than it has to be: one more line of context
--- above would not fit. Guards against a compensation that just scrolls to the end.
local function tight(win, buf)
  local count = vim.api.nvim_buf_line_count(buf)
  local view = vim.api.nvim_win_call(win, function() return vim.fn.winsaveview() end)
  if view.topline <= 1 then return true, "topline=1" end
  local th = vim.api.nvim_win_text_height(win, { start_row = view.topline - 2, end_row = count - 1 })
  local win_h = vim.api.nvim_win_get_height(win)
  return th.all > win_h, ("one_more=" .. th.all .. " win_h=" .. win_h)
end

local IMG_H = image.height_for("image")

--------------------------------------------------------------------------------
-- A: the reserved lines already exist when the scroll is computed
--------------------------------------------------------------------------------

image.set_renderer(stub(true))
pages["line:cA"] = { first = page(10, photo(90, 90000)) }
local bufA, winA = open("line:cA")
check("A: last image fits the viewport (virt_lines already written)", fits(winA, bufA, 0))

--------------------------------------------------------------------------------
-- B: magick has not come back yet, so the height lives only in the spec
--------------------------------------------------------------------------------

image.set_renderer(stub(false))
pages["line:cB"] = { first = page(10, photo(91, 91000)) }
local bufB, winB = open("line:cB")
check("B: last image fits once the pending reservation lands", fits(winB, bufB, IMG_H))

--------------------------------------------------------------------------------
-- E: a keep_cursor redraw from the bottom — the branch late media actually takes
--
-- Same pending-reservation timing as B, but through the `saved` exit of render_full
-- instead of the scroll-to-bottom one. A fix wired only into the scroll-to-bottom branch
-- leaves this one spilling, and this is the branch that runs on every late-media redraw.
--------------------------------------------------------------------------------

pages["line:cE"] = { first = page(10, photo(93, 93000)) }
local bufE, winE = open("line:cE")
messages.render_full("line:cE", { keep_cursor = true })
vim.wait(50, function() return false end)
check("E: keep_cursor redraw from the bottom still fits", fits(winE, bufE, IMG_H))

--------------------------------------------------------------------------------
-- C: no images at all — nothing to compensate for, and nothing to over-scroll
--------------------------------------------------------------------------------

image.set_renderer(stub(true))
pages["line:cC"] = { first = page(12, nil) }
local bufC, winC = open("line:cC")
check("C: a chat with no images still fits", fits(winC, bufC, 0))
check("C: a chat with no images is not scrolled further than it has to be", tight(winC, bufC))

--------------------------------------------------------------------------------
-- F: `[` must keep the reader anchored — F34 must not regress
--------------------------------------------------------------------------------

pages["line:cF"] = { first = page(10, photo(92, 92000)), older = page(10, nil, 100) }
local bufF, winF = open("line:cF")
local before_view = vim.api.nvim_win_call(winF, function() return vim.fn.winsaveview() end)
local before_count = vim.api.nvim_buf_line_count(bufF)
local before_requests = #requests

messages.load_older("line:cF")
vim.wait(2000, function()
  return #requests > before_requests and not state.in_flight["line:cF"]
end)
vim.wait(100, function() return false end)

local delta = vim.api.nvim_buf_line_count(bufF) - before_count
local after_view = vim.api.nvim_win_call(winF, function() return vim.fn.winsaveview() end)
check("F: prepending a page moved the buffer", delta > 0, "delta=" .. delta)
check("F: preserve_view keeps the anchor, compensation does not touch it",
  after_view.topline == before_view.topline + delta,
  ("topline=" .. after_view.topline .. " expected=" .. (before_view.topline + delta)))

--------------------------------------------------------------------------------
-- G (F66): a message that arrives while the reader is at the bottom
--
-- init.lua sends a pure arrival through M.append, not render_full — and image.plan /
-- image.apply have exactly one call site, inside render_full. So every pushed picture used
-- to land as text with nothing drawn under it. Both assertions are needed: checking only
-- the viewport arithmetic passes trivially while nothing is drawn, because nothing that
-- does not exist can overflow.
--------------------------------------------------------------------------------

image.set_renderer(stub(true))
pages["line:cG"] = { first = page(10, nil) }
local bufG, winG = open("line:cG")

local arrival = photo(94, 94000)
state.append_messages("line:cG", { arrival })
messages.append("line:cG", { arrival })
vim.wait(50, function() return false end)

local drawn = image.rendered()
check("G: an appended image is actually drawn", drawn[arrival.id] ~= nil,
  "drawn=" .. vim.inspect(vim.tbl_keys(drawn)))
check("G: an appended image fits the viewport", fits(winG, bufG, 0))

--------------------------------------------------------------------------------

if failures > 0 then
  io.write(("FAILED: %d\n"):format(failures))
  os.exit(1)
end
io.write("ALL PASS\n")
os.exit(0)
