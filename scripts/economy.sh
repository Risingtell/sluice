#!/usr/bin/env bash
# Sluice multi-agent economy runner.
#
# Launches N independent consumer agents — each with its OWN funded Casper wallet — that stream
# from the catalogue. Every stream pays its OWN provider treasury, so settlements flow across
# distinct on-chain parties: a real many-agents → many-providers economy, not one wallet paying
# itself. Drives uniqueAgents and uniqueProviders on the /impact feed.
#
# Usage: TICKS=3 ROUNDS=2 TICK_MS=2500 bash scripts/economy.sh
set -u
cd "$(dirname "$0")/.."

SERVER_URL="${SERVER_URL:-http://localhost:4021}"
TICK_MS="${TICK_MS:-2500}"
TICKS="${TICKS:-3}"
ROUNDS="${ROUNDS:-2}"
AGENTS=(agent agent2 agent3 agent4 agent5)
STREAMS=(btc-usd eth-usd gpu-telemetry)

echo "[economy] ${#AGENTS[@]} agents × ${#STREAMS[@]} providers | ${ROUNDS} rounds × ${TICKS} ticks @ ${TICK_MS}ms"

run_agent() {
  local key="$1"
  for ((r = 0; r < ROUNDS; r++)); do
    for s in "${STREAMS[@]}"; do
      MODE=live SERVER_URL="$SERVER_URL" AGENT_STREAM="$s" \
        AGENT_TICK_MS="$TICK_MS" AGENT_MAX_TICKS="$TICKS" \
        CLIENT_PRIVATE_KEY_PATH="keys/${key}.pem" CLIENT_KEY_ALGO=ed25519 \
        npx tsx agent/src/index.ts 2>&1 | sed "s/^/[$key→$s] /"
      sleep 1
    done
  done
}

# Stagger starts so concurrent settlements don't all hit testnet finality in the same instant.
for key in "${AGENTS[@]}"; do
  run_agent "$key" &
  sleep 3
done
wait
echo "[economy] all agents finished"
