#!/usr/bin/env bash
# One command, because "please save it to .acceptance/" was written into three
# consecutive plans and done zero times. The failure was never forgetfulness — it was
# that no step could be executed, so nothing ever blocked on it.
#
#   ./scripts/acceptance-shot.sh f65-red
#   -> .acceptance/f65-red-20260803-2130.png
#
# Takes the whole screen after a delay, so you can put the window you actually want back
# in front. Screenshots stay local: .gitignore excludes .acceptance/.
#
# The delay defaults to 6 because 3 was not enough on the first real use of this script:
# the shot caught the terminal that launched it instead of the Neovim window, and a
# screenshot of the wrong window is worse than none — it looks like evidence.
set -euo pipefail

label="${1:?usage: acceptance-shot.sh <label> [delay-seconds]}"
delay="${2:-6}"
dir="$(cd "$(dirname "$0")/.." && pwd)/.acceptance"
mkdir -p "$dir"
out="$dir/${label}-$(date +%Y%m%d-%H%M%S).png"

sleep "$delay"
grim "$out"
echo "saved $out"
