# Sluice — Casper Agentic Buildathon 2026 submission

**One line:** Sluice is a streaming x402 meter — agents pay **per second** for continuous resources
(live feeds, GPU time, streaming inference), settled on-chain via Casper x402, with a self-closing
"sluice gate" that halts the stream the instant a payment stops.

- **Repo:** <github repo URL>
- **Live proof feed:** <stable public URL>/impact.html  ·  JSON: <stable public URL>/impact
- **Demo video:** <youtube/loom URL>
- **Network:** `casper:casper-test`

---

## 1. The problem it solves

x402 made machine-to-machine payments real, but every kit in this field is **discrete** — one
request, one payment. That model breaks for the resources agents rent *continuously*:

- a trading agent on a **live BTC/USD feed**,
- an inference job renting **GPU time**,
- any **streaming endpoint** billed by duration.

Per-request billing forces pre-bought credits (locked capital), coarse subscriptions (paying for
idle), or trust-based invoicing (counterparty risk). None of them price *time actually consumed*.

## 2. What Sluice does

A **StreamingMeter** accrues cost per second and settles in rapid micro-batches. Each tick is one
real on-chain payment: the agent signs an EIP-712 `transfer_with_authorization` over a CEP-18 token,
the Casper x402 facilitator verifies and settles it on `casper-test`. **Stop consuming → the next
tick never fires → the stream halts itself.** No escrow, no clawback — the meter is the enforcement.

## 3. Why it wins on merit (the differentiator)

The Buildathon field is ~70% discrete pay-per-request x402 kits plus escrow/reputation/oracle
plumbing. **Continuous per-second streaming settlement was unoccupied.** Sluice is the metering
primitive that makes "rent a resource by the second" a native on-chain operation — not a marketplace,
not an escrow layer.

## 4. It is actually live — and verifiable

This is not a mock. On `casper:casper-test`, Sluice has settled **138 real per-second payments**:

| Metric | Value |
|---|---|
| On-chain settlements | **138** |
| Seconds streamed & billed | **1,190 s** |
| Value transferred | **1.69 X402** (CEP-18) |
| Streams metered | BTC/USD, ETH/USD, GPU telemetry |
| Distinct agents | 1 *(honest caveat below)* |

**Verify any of them:** `GET /impact` returns each settlement's real `txHash` and an
`https://testnet.cspr.live/deploy/<txHash>` link. Click through to see the CEP-18 transfer, the
facilitator's sponsored gas, and the token moving agent → payee.

**Honest caveat:** all volume comes from one funded agent key, so `uniqueAgents = 1`. The
settlements, seconds, and value are 100% real on-chain; the agent *count* is the only number we will
not inflate. Adding agents is operational (mint X402 to more accounts), not a code change.

## 5. How it's built

| Layer | Implementation |
|---|---|
| Streaming meter | `server/src/meter.ts` — elapsed-seconds × rate per tick, with a hard `MAX_TICK_SECONDS` clock-jump guard |
| Settlement abstraction | `server/src/settlement.ts` — `SettlementProvider` interface; identical streaming logic in MOCK (no creds) and LIVE |
| LIVE Casper x402 | `server/src/casper-live.ts` — `paymentMiddleware` + `ExactCasperScheme` + `HTTPFacilitatorClient` + per-tick `DynamicPrice` + `onAfterSettle` → records proof |
| Resource server | `server/src/index.ts` — session/tick routes + durable `/impact` feed |
| Autonomous agent | `agent/src/index.ts` — opens a session, signs + pays each tick via `wrapFetchWithPayment`, stops on its own |
| Durable proof | `server/src/store.ts` — periodic JSON snapshot so cumulative numbers survive restarts |

**Stack:** `@make-software/casper-x402` (Casper `exact` scheme), `@x402/express`/`core`/`fetch`,
`casper-js-sdk`, hosted facilitator `x402-facilitator.cspr.cloud` (gas sponsored via its feePayer).
Node + tsx, no build step.

## 6. Run it in 30 seconds (MOCK, no creds)

```bash
npm install && cp .env.template .env
npm run server
AGENT_TICK_MS=300 AGENT_MAX_TICKS=12 npm run agent   # watch /impact.html fill up
```

LIVE setup and stable hosting: see [`README.md`](README.md) and [`HOSTING.md`](HOSTING.md).

## 7. What's next

- Onboard multiple funded agents to raise `uniqueAgents` honestly.
- Optional Odra `StreamRegistry` contract to make stream terms on-chain & discoverable.
- SDK wrapper so any resource provider drops Sluice in front of an endpoint in a few lines.
