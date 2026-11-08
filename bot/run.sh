#!/bin/sh
# Keeps the bot running; restarts on disconnect. Usage: ./run.sh [STRATEGY] [PARAMS_JSON]
cd "$(dirname "$0")"
export STRATEGY="${1:-${STRATEGY:-apex1}}"
export PARAMS="${2:-${PARAMS:-}}"
while true; do
  npx tsx src/index.ts 2>&1 | tee -a logs/bot.log
  unset BOT_NONCE
  echo "[run.sh] bot exited; restarting in 3s"; sleep 3
done
