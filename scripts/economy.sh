#!/usr/bin/env bash
# Sluice multi-agent economy runner.
#
# Launches N independent, AUTONOMOUS consumer agents — each with its own funded Casper wallet, its
# own objective, and its own budget. Every stream pays its OWN provider treasury. Each agent decides
# per-tick whether the stream is still worth paying for and closes its own gate (objective met, data
# not worth it, or budget reached). Drives uniqueAgents, uniqueProviders, and the decisions feed.
#
# Usage: ROUNDS=1 TICK_MS=2500 bash scripts/economy.sh
set -u
cd "$(dirname "$0")/.."

SERVER_URL="${SERVER_URL:-http://localhost:4021}"
TICK_MS="${TICK_MS:-2500}"
ROUNDS="${ROUNDS:-1}"
CAP="${CAP:-12}" # hard safety cap; the policy normally closes earlier
AGENTS=(agent agent2 agent3 agent4 agent5)
BUDGETS=(0.10 0.03 0.12 0.04 0.15) # varied budgets → a realistic mix of close reasons
STREAMS=(btc-usd eth-usd gpu-telemetry)

echo "[economy] ${#AGENTS[@]} autonomous agents × ${#STREAMS[@]} providers | ${ROUNDS} round(s) @ ${TICK_MS}ms"

run_agent() {
  local key="$1" budget="$2"
  for ((r = 0; r < ROUNDS; r++)); do
    for s in "${STREAMS[@]}"; do
      MODE=live SERVER_URL="$SERVER_URL" AGENT_STREAM="$s" \
        AGENT_TICK_MS="$TICK_MS" AGENT_MAX_TICKS="$CAP" AGENT_BUDGET_X402="$budget" \
        CLIENT_PRIVATE_KEY_PATH="keys/${key}.pem" CLIENT_KEY_ALGO=ed25519 \
        npx tsx agent/src/index.ts 2>&1 | sed "s/^/[$key→$s] /"
      sleep 1
    done
  done
}

# Stagger starts so concurrent settlements don't all hit testnet finality in the same instant.
for i in "${!AGENTS[@]}"; do
  run_agent "${AGENTS[$i]}" "${BUDGETS[$i]}" &
  sleep 3
done
wait
echo "[economy] all agents finished"
