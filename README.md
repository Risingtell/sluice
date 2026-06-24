# 💧 Sluice — streaming x402 meter for the agent economy

**Pay per second of use, settled on-chain via Casper x402, and the meter shuts the instant an
agent stops consuming.** No subscriptions, no pre-bought credits.

Built for the [Casper Agentic Buildathon 2026](https://dorahacks.io/hackathon/casper-agentic-buildathon).

> **It's live.** Sluice has already settled **138 real per-second payments on `casper:casper-test`**,
> each one a CEP-18 `transfer_with_authorization` signed by an autonomous agent and finalized by the
> Casper x402 facilitator — every settlement is clickable through to **testnet.cspr.live**. See the
> [`/impact`](#verify-it-yourself-no-trust-required) proof feed.

---

## The problem

x402 unlocked machine-to-machine payments, but the whole wave so far is **discrete**: one request,
one payment. That fits an API call. It does *not* fit the things agents actually rent continuously —
a **live price feed**, **GPU time**, a **streaming inference endpoint**. Charging those per-request
forces ugly choices: pre-bought credits (capital locked up, refunds), coarse subscriptions (pay for
idle time), or after-the-fact invoicing (counterparty risk).

## The solution — a streaming meter

Sluice adds the missing axis: **continuous, per-second streaming settlement.**

```
Agent (Casper ed25519 key)
  │  opens a session, then every tick signs an EIP-712 transfer_with_authorization
  ▼
Sluice Resource Server  (Express + @x402/express + @make-software/casper-x402)
  │  StreamingMeter bills elapsed-seconds × rate  →  one settlement per tick
  ▼
Casper x402 Facilitator  →  real CEP-18 transfer on casper:casper-test
  ▼
/impact public proof feed  →  every tick, with a testnet.cspr.live explorer link
```

The agent pays only for the seconds it actually consumes. **Stop consuming and the next tick never
fires — the stream halts itself.** That self-closing cutoff is the "sluice gate," and it's the whole
point: no trust, no escrow, no clawback. The meter *is* the enforcement.

## Why it's different from the rest of the field

The Buildathon field is ~70% discrete pay-per-request x402 kits, plus trust/escrow/reputation
plumbing layered on top. **Continuous per-second streaming settlement was unoccupied.** Sluice isn't
a marketplace and isn't an escrow — it's the metering primitive that makes *renting a resource by the
second* a first-class on-chain operation.

---

## Verify it yourself (no trust required)

Every settlement Sluice has ever made is recorded with its real Casper transaction hash:

```bash
# top-line cumulative proof
curl -s http://localhost:4021/impact | jq '.totals'
# => { "settlements": 138, "secondsStreamed": 1190, "totalPaid": "1692363700", ... }

# pull any recent settlement and open it on the block explorer
curl -s http://localhost:4021/impact | jq '.recent[0] | {txHash, explorerUrl, amount, seconds}'
```

Open any `explorerUrl` (`https://testnet.cspr.live/deploy/<txHash>`) and you'll see a real CEP-18
transfer on `casper:casper-test`, gas paid by the facilitator's sponsored feePayer, the X402 token
moving from the agent's account to the payee. The live dashboard at **`/impact.html`** renders the
same feed.

**Honest caveat:** all current volume comes from **one** funded agent key (`uniqueAgents = 1`). The
settlements, seconds streamed, and value transferred are 100% real on-chain; the *number of distinct
agents* is the one number we are not inflating. Onboarding more funded agents is purely operational
(mint the X402 token to more accounts), not a code change.

---

## Run it

### MOCK demo — zero credentials
```bash
npm install
cp .env.template .env            # MODE=mock by default
npm run server                   # http://localhost:4021  ·  dashboard at /impact.html
# in another terminal:
AGENT_TICK_MS=300 AGENT_MAX_TICKS=12 npm run agent
```
The streaming meter is decoupled from settlement behind a `SettlementProvider` interface, so MOCK
mode runs the *exact same* streaming logic with simulated settlement — no creds, no chain.

### LIVE on Casper testnet
Fill the LIVE section of `.env` (facilitator API key from cspr.cloud, funded testnet ed25519
account, deployed CEP-18 token package) and set `MODE=live`:
```bash
MODE=live npm run server
MODE=live CLIENT_PRIVATE_KEY_PATH=keys/agent.pem npm run agent
```
Sustained load for the proof feed: `WORKERS=3 TICK_MS=2000 TICKS=12 bash scripts/volume.sh`.
See [`docs/PLAN.md`](docs/PLAN.md) for the full owner setup checklist and
[`HOSTING.md`](HOSTING.md) for putting the proof feed on a stable public URL.

> **Testnet tuning:** each on-chain settle finalizes in ~5–10s (testnet block time), so hold tick
> cadence ≥ ~1.5s. `MAX_TICK_SECONDS` caps elapsed billing so a slow settle never over-bills.

---

## HTTP API

| Method & path | What |
|---|---|
| `GET /streams` | catalogue of metered streams (BTC/USD, ETH/USD, GPU telemetry) + per-second rate |
| `POST /sessions` | open a metered session for a stream |
| `POST /tick?session=<id>` | bill elapsed seconds and settle one payment (the per-second tick) |
| `POST /sessions/:id/close` | close the gate |
| `GET /impact` | cumulative totals + recent settlements (JSON proof feed) |
| `GET /health` | liveness |

## Layout

| Path | What |
|------|------|
| `server/src/meter.ts` | **StreamingMeter** — the core primitive (elapsed-seconds tick billing + cutoff) |
| `server/src/settlement.ts` | `SettlementProvider` interface + `MockSettlementProvider` |
| `server/src/casper-live.ts` | LIVE Casper x402 wiring (paymentMiddleware + ExactCasperScheme + HTTPFacilitatorClient + DynamicPrice + onAfterSettle) |
| `server/src/store.ts` | durable proof-feed store (periodic JSON snapshot) |
| `server/src/index.ts` | Express resource server + session/tick routes + `/impact` |
| `server/public/impact.html` | live proof-feed dashboard |
| `agent/src/index.ts` | autonomous consuming agent (streams, pays per tick, stops on its own) |
| `scripts/volume.sh` | sustained-load runner (N concurrent agents → real settlements) |
| `shared/types.ts` | wire types |
| `docs/PLAN.md` | architecture, plan, owner prerequisites |

## Tech

`@make-software/casper-x402` (Casper `exact` scheme) · `@x402/express` + `@x402/core` + `@x402/fetch`
· `casper-js-sdk` · hosted facilitator at `x402-facilitator.cspr.cloud` (sponsored gas via its
feePayer). Node + tsx, no build step.

MIT.
