# 💧 Sluice — streaming x402 meter for the agent economy

**Pay per second of use, settled on-chain via Casper x402, and the meter shuts the instant an
agent stops consuming.** No subscriptions, no pre-bought credits.

Built for the [Casper Agentic Buildathon 2026](https://dorahacks.io/hackathon/casper-agentic-buildathon).

## Why it's different
The x402 wave so far is discrete, per-request payments (and trust/escrow plumbing on top). Sluice
adds the missing axis: **continuous, per-second streaming settlement.** An agent renting a live data
feed, GPU time, or any continuous resource pays only for the seconds it actually consumes — and the
stream halts the moment a tick goes unpaid (the "sluice gate").

## How it works
```
Agent (Casper ed25519 key)
  │  opens a session, then per tick signs an EIP-712 transfer_with_authorization
  ▼
Resource Server (Express + @x402/express + @make-software/casper-x402)
  │  StreamingMeter bills elapsed seconds × rate; each tick = one settlement
  ▼
Casper x402 Facilitator  →  CEP-18 transfer on casper:casper-test
  ▼
/impact public proof feed (every tick, with explorer links)
```

The streaming meter is decoupled from settlement behind a `SettlementProvider` interface, so it runs
in **MOCK mode with zero credentials** (simulated settlement) and flips to **LIVE** Casper x402 by
setting env vars — no code change to the streaming logic.

## Run the MOCK demo (no creds needed)
```bash
npm install
cp .env.template .env          # MODE=mock by default
npm run server                 # http://localhost:4021  ·  proof feed at /impact.html
# in another terminal:
AGENT_TICK_MS=300 AGENT_MAX_TICKS=12 npm run agent
```
Watch per-second settlements stream in the agent log and on `http://localhost:4021/impact.html`.

## Going LIVE (Casper testnet)
Fill the LIVE section of `.env` (facilitator API key from cspr.cloud, funded testnet account,
CEP-18 token) and set `MODE=live`. See [`docs/PLAN.md`](docs/PLAN.md) for the owner checklist.

## Layout
| Path | What |
|------|------|
| `server/src/meter.ts` | StreamingMeter — the core primitive (tick billing + cutoff) |
| `server/src/settlement.ts` | SettlementProvider interface + MockSettlementProvider |
| `server/src/index.ts` | Express resource server, session routes, `/impact` feed |
| `server/public/impact.html` | live proof-feed dashboard |
| `agent/src/index.ts` | autonomous consuming agent (streams, pays per tick, stops on its own) |
| `shared/types.ts` | wire types |
| `docs/PLAN.md` | architecture, 8-day plan, owner prerequisites |

MIT.
