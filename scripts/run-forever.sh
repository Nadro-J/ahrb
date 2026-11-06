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
cd "$(dirname "$0")/.."

delay=30
while true; do
  started=$(date +%s)
  npm start --silent
  code=$?
  case $code in
    0 | 2 | 130)
      echo "$(date -u +%FT%TZ) bot exited with code $code: not restarting"
      exit "$code"
      ;;
  esac
  # Back off if it keeps crashing straight away (up to 10 min); reset after a good run.
  if (($(date +%s) - started > 600)); then delay=30; else delay=$((delay * 2 > 600 ? 600 : delay * 2)); fi
  echo "$(date -u +%FT%TZ) bot crashed (exit $code): restarting in ${delay}s (Ctrl+C to cancel)" | tee -a data/restarts.log
  sleep "$delay"
done
