#!/usr/bin/env bash
# Sluice volume runner: keeps N concurrent autonomous agents looping against the LIVE server,
# producing REAL on-chain Casper x402 micro-settlements that accumulate in the /impact proof feed.
#
# Each worker runs the real agent (signs EIP-712 transfer_with_authorization per tick, settled by
# the facilitator), then reopens a fresh session and repeats. Streams are rotated across workers.
# Tick cadence is held >=2s because each on-chain settle finalizes in ~5-10s on testnet (faster
# cadence causes transient 500s — see project notes).
#
# Usage: WORKERS=3 TICK_MS=2000 TICKS=12 bash scripts/volume.sh
set -u
cd "$(dirname "$0")/.."

WORKERS="${WORKERS:-3}"
TICK_MS="${TICK_MS:-2000}"
TICKS="${TICKS:-12}"
STREAMS=(btc-usd eth-usd gpu-telemetry)

echo "[volume] starting $WORKERS workers | tick ${TICK_MS}ms | ${TICKS} ticks/session"

worker() {
  local idx="$1"
  local stream="${STREAMS[$(( idx % ${#STREAMS[@]} ))]}"
  local n=0
  while true; do
    n=$((n+1))
    echo "[w$idx][$stream] session #$n $(date -u +%H:%M:%S)"
    MODE=live \
    SERVER_URL=http://localhost:4021 \
    AGENT_STREAM="$stream" \
    AGENT_TICK_MS="$TICK_MS" \
    AGENT_MAX_TICKS="$TICKS" \
    CLIENT_PRIVATE_KEY_PATH=keys/agent.pem \
    CLIENT_KEY_ALGO=ed25519 \
    npx tsx agent/src/index.ts 2>&1 | sed "s/^/[w$idx] /"
    sleep 1
  done
}

# Stagger worker starts so settlements don't all land on the chain in the same instant.
for i in $(seq 0 $((WORKERS-1))); do
  worker "$i" &
  sleep 3
done
wait
