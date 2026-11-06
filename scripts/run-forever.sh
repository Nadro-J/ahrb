#!/usr/bin/env bash
# Keeps the bot running: restarts it after a crash, but not after a halt or a
# stop you asked for. Run it inside tmux (scripts/arb.service does that at boot).
#
#   exit 0    stopped on purpose (Ctrl+C, SIGTERM, kill switch at start) → stay stopped
#   exit 2    halted (daily loss limit, XCM not arriving, data/STOP) → stay stopped:
#             look at it before starting again
#   exit 130  forced stop (Ctrl+C twice) → stay stopped
#   anything else (a crash, a lost connection at start) → wait, then start again
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
# Every start and exit goes to data/runs.log. The tmux session closes when the bot stops for good,
# taking its screen with it; this file says why. (Not the dashboard itself: piping stdout would turn it off.)
note() { echo "$(date -u +%FT%TZ) $*" | tee -a data/runs.log; }
command -v npm >/dev/null || { note "npm not found on PATH ($PATH): fix PATH in arb.service"; exit 1; }
[ -f .env ] || note "warning: no .env in $(pwd): ARB_MNEMONIC must come from the environment"

delay=30
while true; do
  started=$(date +%s)
  note "starting the bot"
  npm start --silent
  code=$?
  case $code in
    0 | 2 | 130)
      note "bot exited with code $code ($([ "$code" = 2 ] && echo halted || echo stopped)): not restarting"
      exit "$code"
      ;;
  esac
  # Back off if it keeps crashing straight away (up to 10 min); reset after a good run.
  if (($(date +%s) - started > 600)); then delay=30; else delay=$((delay * 2 > 600 ? 600 : delay * 2)); fi
  note "bot crashed (exit $code): restarting in ${delay}s (Ctrl+C to cancel)"
  sleep "$delay"
done
