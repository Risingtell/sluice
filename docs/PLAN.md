# Sluice — streaming x402 meter for the agent economy

**Casper Agentic Buildathon 2026 (DoraHacks) — Qualification Round**
Deadline: **2026-07-01 01:00 UTC** · Prize pool $150k · Submission needs GitHub repo + demo video.

## One-liner
Agents shouldn't buy subscriptions or pre-load credits. With Sluice they **pay per second of
use, settled on-chain via Casper x402, and the meter shuts the instant they stop consuming.**

## Why it can win
- **Different axis from the field.** ~70% of BUIDLs are discrete per-request payment kits or
  trust/escrow/reputation plumbing. Nobody is doing *continuous / streaming* settlement.
- **Proven primitive.** Ported in spirit from Driplet (per-second nanopayments, real traction).
- **Real on-chain proof.** Casper sponsors free x402 Facilitator usage → we can show
  *thousands* of real testnet settlements on a public `/impact` feed judges can verify.

## Architecture
```
Agent (Casper ed25519 key)
   │ consumes continuous feed; every tick signs an EIP-712 transfer_with_authorization
   ▼
Resource Server (Express + @x402/express paymentMiddleware + ExactCasperScheme)
   │ meter accrues cost/sec; each tick forwards payload to facilitator
   ▼
Casper x402 Facilitator (hosted: https://x402-facilitator.cspr.cloud) /verify then /settle
   │ submits CEP-18 transfer_with_authorization deploy on casper:casper-test
   ▼
On-chain settlement  ──►  /impact public proof feed (live settlements + cspr.live explorer links)
```
Optional Phase 2 (only this needs `cargo-odra`): an **Odra `StreamRegistry`** contract that
records session open/close + cumulative paid, for richer on-chain verifiability than raw transfers.

## Tech stack (confirmed published)
- `@make-software/casper-x402@1.0.0` (Casper exact scheme: client + server + facilitator)
- `@x402/express`, `@x402/core`, `@x402/fetch` @ 2.16.0 (upstream x402 SDK)
- `casper-js-sdk@5.0.12`, `express`, `cors`, `dotenv`
- Web (proof feed + landing): Next.js or static — decide for speed.

## How streaming maps onto per-request x402
x402 is per-request. Streaming = **meter accrues per second, settles in rapid micro-batches**
(configurable tick, e.g. settle every N seconds or every M motes accrued). Each batch = one real
on-chain settlement. Stop consuming → next tick never fires → stream halts. That cutoff IS the
product ("sluice gate").

## Owner prerequisites (external — like the Driplet SQL / Aegis API key)
1. **Casper x402 Facilitator API key** — sign up at cspr.cloud; buildathon sponsors free usage.
   Needed as `FACILITATOR_API_KEY`.
2. **Casper testnet account** — ed25519 PEM key (we can generate locally, no casper-client needed).
   Fund with testnet CSPR from the faucet.
3. **CEP-18 test token (e.g. WCSPR)** — the asset payments settle in; `ASSET_PACKAGE` hash.
Until creds land, the spine runs in **MOCK mode** (simulated settlement) so the streaming UX +
proof feed are fully buildable offline. Flip an env flag to go live.

## 8-day schedule (today 2026-06-22 → deadline 07-01)
- **D1 (today):** isolated repo, plan, scaffold server+agent, MOCK-mode streaming meter working end-to-end locally with a live tick loop + per-tick "settlement" events.
- **D2:** real Casper signing path wired (ExactCasperScheme client/server), facilitator client; keep MOCK fallback. Generate testnet key. Write owner cred checklist.
- **D3:** `/impact` proof feed + cumulative stats; landing page with the narrative.
- **D4:** go LIVE on testnet once creds land — first real on-chain settlement; harden tick/batch + lapse-cutoff logic.
- **D5:** drive real volume (let the agent stream for a long session) → thousands of settlements; polish dashboards; explorer deep-links.
- **D6:** (optional) Odra StreamRegistry; otherwise reliability hardening + edge cases (insufficient balance, signature replay window, reconnect).
- **D7:** demo video script + record; SUBMISSION.md; README with run instructions.
- **D8 buffer:** submit on DoraHacks, final polish, redeploy.

## Isolation rule (per owner)
Everything lives in `C:\Users\HP\sluice` with its own git repo + node_modules. **Zero edits** to
the live store/website or any other project (Driplet, Veil, Bequest, Aegis…). Concept ported from
memory, not files. No shared global state (cargo-odra deferred to optional phase).
