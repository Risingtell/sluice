# Sluice demo video — script & shot list (target 2:30, hard cap 3:00)

Goal: a judge who watches once should believe (a) the idea is genuinely new in this field, and
(b) it is **really settling on-chain right now**, not a mock. Lead with the problem, prove it live,
end on the verifiable feed.

**Prep before recording**
- LIVE server running: `MODE=live npm run server`
- A terminal ready with the agent command (don't run it yet).
- Browser tabs open: `/impact.html`, and `https://testnet.cspr.live` (logged out is fine).
- Screen clean, font size up. Record at 1080p.

---

### 0:00–0:25 — The problem (talking head or title card + voiceover)
> "x402 made agents pay for things. But every kit out there is one-request-one-payment. That works
> for an API call. It does **not** work for the things agents actually rent by time — a live price
> feed, GPU minutes, a streaming model. You either pre-buy credits, overpay for a subscription, or
> trust an invoice. Nobody prices the *seconds actually used*."

### 0:25–0:45 — The idea (show the flow diagram from the README)
> "Sluice is a streaming meter. It bills per second and settles each tick on Casper x402. And the
> moment the agent stops paying, the next tick never fires — the stream closes itself. We call it the
> sluice gate. No escrow, no clawback. The meter is the enforcement."

### 0:45–1:40 — Prove it live (screen recording — the core of the video)
1. Show `/impact.html` with its current cumulative totals (138 settlements). Say "this is real,
   on `casper-test`, and I'll add to it right now."
2. Run the agent in the terminal:
   ```
   MODE=live CLIENT_PRIVATE_KEY_PATH=keys/agent.pem AGENT_TICK_MS=2000 AGENT_MAX_TICKS=6 npm run agent
   ```
3. Narrate as the log scrolls: each tick prints the seconds billed, the amount, and a
   `tx … testnet.cspr.live/deploy/…` link. "Every line there is a signed transfer_with_authorization,
   settled by the facilitator."
4. Cut to `/impact.html` refreshing — the counter ticks up live, new rows appear.

### 1:40–2:10 — Make it undeniable (verify on-chain)
1. Copy a `txHash` from the agent log (or the feed).
2. Paste the `testnet.cspr.live/deploy/<hash>` URL into the browser.
3. Show the real CEP-18 transfer: agent → payee, facilitator-paid gas, status processed.
> "That's the whole claim, on a public block explorer. Not a mock."

### 2:10–2:30 — Differentiator + honest close
> "The Buildathon field is almost entirely discrete pay-per-request and escrow plumbing. Per-second
> streaming settlement was the open lane — and Sluice is live in it. One honest note: all this volume
> is from a single funded agent today; the settlements are 100% real, adding more agents is just
> minting the token to more accounts. Sluice — pay by the second, settle on Casper, close the gate
> when you stop."

---

**Editing notes**
- Keep the on-chain explorer shot on screen long enough to read (3–4s).
- Lower-third captions for the three numbers: 138 settlements · 1,190 s streamed · casper-test.
- If a tick hits a transient 500 (settle finality), just cut it — cadence ≥2s avoids it.
