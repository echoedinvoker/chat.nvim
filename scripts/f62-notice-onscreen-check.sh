#!/usr/bin/env bash
# On-screen check for F62: is the notice actually DRAWN, and is the first chat still there?
#
#   bash scripts/f62-notice-onscreen-check.sh
#
# This exists because scripts/f62-notice-anchor-check.lua cannot answer either question.
# That script asserts the shape of what was created; on 2026-08-02 it was ALL PASS while
# the screen showed nothing at all, because `virt_lines_above` anchored at line 0 creates a
# valid extmark that Neovim has nowhere to draw and silently never renders. "Created" and
# "drawn" are different claims, and only one of them is what a user sees.
#
# So this runs a real Neovim with a real UI inside tmux and reads the characters off the
# screen. No API calls, no extmark introspection — if it is not in capture-pane, it is not
# on screen.
set -u

cd "$(dirname "$0")/.." || exit 1
SESSION="f62-onscreen-$$"
INIT=$(mktemp /tmp/f62-onscreen-XXXX.lua)
fails=0

check() { # label, condition-as-exit-status of the caller's `[ ]`
  if [ "$2" = "0" ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}

cat >"$INIT" <<'LUA'
vim.opt.runtimepath:append(vim.fn.getcwd())
package.loaded["chat-nvim.sidecar"] = {
  send = function() end, start = function() end, stop = function() end,
  is_running = function() return true end, set_notification_handler = function() end,
}
local chat_list = require("chat-nvim.ui.chat_list")
chat_list.open()
local buf = chat_list.get_bufnr()
vim.api.nvim_set_current_win(vim.fn.bufwinid(buf))
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "FIRSTCHAT", "SECONDCHAT", "THIRDCHAT" })
vim.bo[buf].modifiable = false
require("chat-nvim.ui.notify").set_persistent_notice("NOTICETEXT")
LUA

tmux new-session -d -s "$SESSION" -x 80 -y 20 "nvim --clean -u NONE -S $INIT" || {
  echo "FAIL could not start tmux session"; rm -f "$INIT"; exit 1; }
sleep 2
SCREEN=$(tmux capture-pane -p -t "$SESSION")
tmux kill-session -t "$SESSION" 2>/dev/null
rm -f "$INIT"

echo "$SCREEN" | grep -q "NOTICETEXT"; check "the notice is on screen" "$?"
echo "$SCREEN" | grep -q "FIRSTCHAT"; check "the first chat is still on screen" "$?"

# Order, not just presence: the notice belongs above the list, and "above" is the whole
# point of F62 — a notice wedged between the first and second chat is a smaller lie, not
# the fix.
notice_row=$(echo "$SCREEN" | grep -n "NOTICETEXT" | head -1 | cut -d: -f1)
first_row=$(echo "$SCREEN" | grep -n "FIRSTCHAT" | head -1 | cut -d: -f1)
[ -n "$notice_row" ] && [ -n "$first_row" ] && [ "$notice_row" -lt "$first_row" ]
check "the notice is above the first chat" "$?"

if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; fi
[ "$fails" -eq 0 ]
