-- F43 機械檢查：媒體從 pending 變成 ready 時，狀態層必須回報 changed，
-- 否則 sidecar 推來的重繪會被靜默吞掉。
--   nvim --headless -l scripts/f43-media-redraw-check.lua
-- 輸出走 io.write：print/vim.notify 會排隊觸發 "Press ENTER"，headless 會卡住。
vim.opt.runtimepath:append(vim.fn.getcwd())
local state = require("chat-nvim.state")

local fails = 0
local function check(name, ok)
  io.write((ok and "ok   " or "FAIL ") .. name .. "\n")
  if not ok then fails = fails + 1 end
end

local base = {
  id = "telegram:1", chat_id = "c", sender_name = "a", text = "[image]",
  timestamp = 1, edited_at = nil, retracted_at = nil, content_type = "image",
  media = { state = "pending" },
}
state.append_messages("c", { base })

-- 文字刻意保持相同：F44 之後 placeholder 與 caption 的文字關係更難推，
-- 「pending → ready 剛好讓 text 也變了」不能再當成重繪的依據。
local ready = vim.tbl_extend("force", {}, base)
ready.media = { state = "ready", path = "/c/telegram/msg/c/1.jpg" }
local added, changed = state.append_messages("c", { ready })
check("media pending->ready counts as changed", #added == 0 and #changed == 1)

local again = vim.tbl_extend("force", {}, ready)
local _, changed2 = state.append_messages("c", { again })
check("an identical redelivery is not a change", #changed2 == 0)

-- 只有路徑換了（同一則訊息重新抓、落到別的檔）也必須算變更，
-- 否則畫面會繼續指著舊檔。
local moved = vim.tbl_extend("force", {}, ready)
moved.media = { state = "ready", path = "/c/telegram/msg/c/1-new.jpg" }
local _, changed3 = state.append_messages("c", { moved })
check("a new path on the same state counts as changed", #changed3 == 1)

io.write(fails == 0 and "ALL PASS\n" or (fails .. " FAILED\n"))
vim.cmd("cquit " .. (fails == 0 and 0 or 1))
