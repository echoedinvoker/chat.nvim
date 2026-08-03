-- F67 feasibility probe: can `winrestview({topfill = N})` scroll into a below-line
-- `virt_lines` block, so the top of the window shows the bottom half of an image?
--
-- Why this exists: the mother note proposed topfill as the fix for the gap under the last
-- image, and flagged its own proposal as unverified — `topfill` is documented for diff
-- filler lines, and image.nvim's pictures are virt_lines. This script answers that one
-- question with readings instead of reasoning, so F67 can be closed either way.
--
-- Run it in a REAL terminal, not --headless:
--   nvim -u NONE
--   :luafile ~/Documents/chat.nvim/scripts/f67-topfill-probe.lua
--   :qa!
--   cat /tmp/f67-topfill-probe.txt
--
-- Not because screenstring fails under --headless (it does not — that was checked), but
-- because a headless screen is not the screen this question is about: font, how many rows
-- virt_lines actually occupy, and image.nvim's reserved block all differ there. A reading
-- taken in that environment cannot speak for the real one in either direction.
--
-- No print/notify/echo anywhere: multiple messages trigger "Press ENTER" and the cmdline is
-- off limits in this project. Results go to a file and to a scratch buffer.

local OUT = "/tmp/f67-topfill-probe.txt"
local VIRT_ROWS = 12 -- image.lua HEIGHT.image — a photo's reserved block
local ANCHOR_LINE = 20 -- 1-based buffer line the virt_lines hang under
local WIN_HEIGHT = 10

local out = {}
local function record(s)
  out[#out + 1] = s
end

-- Buffer: 40 plain lines, with a 12-row virt_lines block under line 20. Every virtual row
-- is individually labelled, because that is what makes reading B falsifiable: seeing
-- "VIRT-07" at the top of the window and seeing "line 21" there are different answers, and
-- a probe that could not tell them apart would only ever confirm itself.
local buf = vim.api.nvim_create_buf(false, true)
local lines = {}
for i = 1, 40 do
  lines[i] = string.format("line %02d", i)
end
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)

local ns = vim.api.nvim_create_namespace("f67_topfill_probe")
local virt = {}
for i = 1, VIRT_ROWS do
  virt[i] = { { string.format("VIRT-%02d", i), "Comment" } }
end
vim.api.nvim_buf_set_extmark(buf, ns, ANCHOR_LINE - 1, 0, { virt_lines = virt })

vim.cmd("botright split")
local win = vim.api.nvim_get_current_win()
vim.api.nvim_win_set_buf(win, buf)
vim.api.nvim_win_set_height(win, WIN_HEIGHT)

-- Reading B: what the first row of the window actually shows, off the screen grid. Not
-- nvim_win_text_height — that one computes a theoretical height from a buffer row range and
-- never looks at where the window is scrolled to, so it would agree with reading A no matter
-- what, which is precisely the failure R4 is watching for.
local function top_row_text()
  local pos = vim.fn.win_screenpos(win) -- { screen_row, screen_col }, 1-based
  local s = ""
  for c = pos[2], pos[2] + 12 do
    s = s .. vim.fn.screenstring(pos[1], c)
  end
  return s
end

local function attempt(label, view)
  vim.api.nvim_set_current_win(win)
  -- Start from a known place, or a previous attempt's scroll position leaks into this one
  -- (the f58 script produced four identical topline readings that way, and they were green).
  vim.fn.winrestview({ topline = 1, topfill = 0, lnum = 1, col = 0 })
  vim.cmd("redraw")

  vim.fn.winrestview(view)
  -- A, before any redraw: did nvim accept the value at all?
  local a_before = vim.fn.winsaveview().topfill
  vim.cmd("redraw")
  -- A, after redraw: did it survive being drawn? Splitting A in two is not in the plan —
  -- without it, "nvim never accepts topfill here" and "nvim accepts it and redraw discards
  -- it" produce the same single number, and they are different answers about why.
  local a_after = vim.fn.winsaveview().topfill
  local b = top_row_text()
  local topline = vim.fn.winsaveview().topline

  record(string.format("--- %s", label))
  record(string.format("  requested      : topline=%s topfill=%s", view.topline, view.topfill))
  record(string.format("  A topfill (pre-redraw)  : %d", a_before))
  record(string.format("  A topfill (post-redraw) : %d", a_after))
  record(string.format("  topline settled : %d", topline))
  record(string.format("  B top_row       : %q", b))
end

record(string.format("f67 topfill x virt_lines probe"))
record(string.format("nvim            : %s", tostring(vim.version())))
record(string.format("virt_lines rows : %d under buffer line %d", VIRT_ROWS, ANCHOR_LINE))
record(string.format("window height   : %d", WIN_HEIGHT))
record("")
record("B starting with VIRT- => the window top really sits inside the virt_lines block.")
record("B starting with 'line ' => topfill was ignored; the top is a whole text line.")
record("B empty => measurement invalid (screenstring out of bounds). Re-run; not a verdict.")
record("")

attempt("anchor+1 (topline=21, topfill=6)", { topline = 21, topfill = 6, lnum = 21, col = 0 })
attempt("anchor   (topline=20, topfill=6)", { topline = 20, topfill = 6, lnum = 20, col = 0 })

local text = table.concat(out, "\n") .. "\n"
local fh = io.open(OUT, "w")
if fh then
  fh:write(text)
  fh:close()
end

-- Also on screen, so the readings can be eyeballed without leaving nvim.
local report = vim.api.nvim_create_buf(false, true)
vim.api.nvim_buf_set_lines(report, 0, -1, false, vim.split(text, "\n"))
vim.api.nvim_win_set_buf(win, report)
vim.api.nvim_win_set_height(win, 20)
