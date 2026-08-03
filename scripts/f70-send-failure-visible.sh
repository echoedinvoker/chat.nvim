#!/usr/bin/env bash
# On-screen check for F70: when a send fails, does the screen SAY it failed?
#
#   bash scripts/f70-send-failure-visible.sh
#
# Before F70 it could not. core hands a failed send back as data (`{success:false}`) and
# never throws; the sidecar passed that through as a result; composer.lua only ever looked at
# `err`. So every send — delivered or not — drew "Sent". This runs the real path (real
# sidecar subprocess, real daemon, real keystrokes) and reads the characters off the screen.
#
# Why an unregistered platform and not just a bogus chat id: `nosuchplatform` can never be a
# connected adapter, so this failure is deterministic and stays deterministic after F70's
# defect B (the tripped kill switch) is fixed. A bogus telegram id currently fails for the
# kill switch's reason, which would stop being true the moment that is repaired.
#
# Nothing is sent to a real chat: an unregistered platform has nowhere to send to.
#
# F62's lesson applies: "extmark created" is not "extmark drawn", so this asserts on
# tmux capture-pane, never on nvim_buf_get_extmarks. And send_feedback deletes itself after
# 3000ms, so the capture has to happen inside that window — if it does not, this says so
# instead of reading the empty screen as "nothing was displayed".
set -u

cd "$(dirname "$0")/.." || exit 1
SESSION="f70-sendfail-$$"
INIT=$(mktemp /tmp/f70-sendfail-XXXX.lua)
BOGUS_CHAT="${F70_BOGUS_CHAT:-nosuchplatform:1}"
MARKER="f70-must-not-arrive"
EXPECT_ON_SCREEN="${F70_EXPECT:-Send failed}"
fails=0

check() { # label, "0" for ok
  if [ "$2" = "0" ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}

cat >"$INIT" <<LUA
vim.opt.runtimepath:append(vim.fn.getcwd())
require("chat-nvim.sidecar").start()
-- Straight to the messages view for a chat no adapter can serve. Going through the chat
-- list would make this depend on which chats the daemon happens to know about today.
require("chat-nvim.ui.messages").open("$BOGUS_CHAT")
LUA

tmux new-session -d -s "$SESSION" -x 120 -y 30 "nvim --clean -u NONE -S $INIT" || {
  echo "FAIL could not start tmux session"; rm -f "$INIT"; exit 1; }

# The sidecar is a bun subprocess talking to the daemon over a socket; give it time to come
# up before the first keystroke, or `c` lands before the UI exists.
sleep 4

tmux send-keys -t "$SESSION" "c"
sleep 1
tmux send-keys -t "$SESSION" "$MARKER"
sleep 0.5
tmux send-keys -t "$SESSION" Escape
sleep 0.3
tmux send-keys -t "$SESSION" Enter
# The round trip is a local socket call; half a second is plenty, and it leaves 2.5s of the
# feedback's 3s lifetime to spare.
sleep 0.7
SCREEN=$(tmux capture-pane -p -t "$SESSION")
tmux kill-session -t "$SESSION" 2>/dev/null
rm -f "$INIT"

# Told apart from "nothing was displayed": an empty capture means the harness missed its
# window, which is a broken check, not a failing feature.
if [ -z "$(echo "$SCREEN" | tr -d '[:space:]')" ]; then
  echo "FAIL captured nothing within 3s — the harness missed the feedback window, verdict unknown"
  exit 1
fi

echo "$SCREEN" | grep -q "$EXPECT_ON_SCREEN"; check "the screen says the send failed" "$?"

# The reason travels with it. "Send failed" alone would leave the user where F70 started:
# knowing something is wrong, with no idea what.
echo "$SCREEN" | grep -q "adapter is not connected"; check "the screen carries core's reason" "$?"

# The whole defect in one assertion: it must not claim success.
echo "$SCREEN" | grep -qE '(^|[^a-zA-Z])Sent([^a-zA-Z]|$)'
if [ "$?" = "1" ]; then echo "ok   the screen does not say Sent"; else
  echo "FAIL the screen says Sent"; fails=$((fails + 1)); fi

if [ "$fails" -ne 0 ]; then
  echo "--- captured screen ---"
  echo "$SCREEN"
fi

if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; fi
[ "$fails" -eq 0 ]
