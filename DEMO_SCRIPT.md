# Sluice demo video — script & shot list (target 2:30, hard cap 3:00)

Goal: a judge who watches once should believe (a) the idea is genuinely new in this field, (b) it's
**really on-chain** (not a mock), and (c) the agents are **genuinely autonomous**. Lead with the
problem, prove it on-chain, show an agent decide for itself, close on the differentiator.

## Prep before recording
1. **Check the facilitator quota** (decides one branch below). In a terminal:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: $(grep '^FACILITATOR_API_KEY=' .env | cut -d= -f2)" https://x402-facilitator.cspr.cloud/supported
   ```
   - `200` → quota is fresh: you can run a **LIVE** agent and show a brand-new settlement land.
   - `429` → quota used up for the day: run the agent in **MOCK** mode for the "watch it decide"
     shot (the autonomy is identical; only the settlement is simulated). Your **275 already-settled,
     on-chain-verifiable payments** are the proof — that part needs no quota.
2. Browser tabs open: the live site **https://risingtell.github.io/sluice/impact.html**, a
   `testnet.cspr.live` tab, and the **SluiceRegistry** contract page (link in the dashboard footer).
3. One clean terminal in the project folder. Screen tidy, font size up, record at 1080p.
4. Screen recorder: Windows **Win+Alt+R** to start/stop (saves to `Videos\Captures`).

---

### 0:00–0:25 — The problem
> "x402 let agents pay for things — but every kit out there is one request, one payment. That fits an
> API call. It does **not** fit what agents actually rent *continuously*: a live price feed to trade
> on, GPU time for a job. You either pre-buy credits, overpay for a subscription, or trust an invoice.
> Nobody prices the *seconds actually used*."

### 0:25–0:45 — The idea
> "Sluice is a streaming meter. Agents pay **per second**, settled on Casper x402. And the instant an
> agent stops paying, the next tick never fires — the stream closes itself. We call it the sluice
> gate: no escrow, no clawback. The meter *is* the enforcement."

### 0:45–1:35 — Prove it's real (the live site + on-chain) — *no quota needed*
1. Open **`/impact.html`**. Read the top numbers: **275 settlements · 5 agents · 3 providers**.
   > "This is a real economy on Casper testnet — five autonomous agents, each its own funded wallet,
   > paying three independent providers."
2. Point at the **Autonomous agent decisions** panel — read 1–2 lines aloud (e.g. *"signal: +0.45%
   move detected — objective met"*, *"GPU 79°C — aborted job"*). 
   > "Every payment is a decision: the agent acts on real data, then closes its own gate."
3. Click any **tx hash** in the feed → opens on `testnet.cspr.live`.
   > "Each tick is a real CEP-18 transfer, agent to provider. Verifiable, on a public explorer."
4. Click the **SluiceRegistry** link in the footer.
   > "And we deployed our own Casper contract that anchors these totals on-chain — so the numbers
   > aren't just our server's word, they're verifiable against chain state."

### 1:35–2:10 — Watch an agent decide for itself (the agentic shot)
Run one agent (use `MODE=live` if quota was 200, else `MODE=mock`):
```
MODE=live SERVER_URL=http://localhost:4021 AGENT_STREAM=gpu-telemetry \
  AGENT_TICK_MS=3000 AGENT_MAX_TICKS=10 AGENT_BUDGET_X402=0.05 \
  CLIENT_PRIVATE_KEY_PATH=keys/agent2.pem CLIENT_KEY_ALGO=ed25519 npm run agent
```
Narrate as it runs: it prints its **objective**, then each tick a 🧠 decision line, then **closes the
gate itself** ("job complete", or "GPU over 78°C — aborted", or "budget reached").
> "It's not a loop with a counter. It has a goal and a budget, it reads the live data every second,
> and it decides when the stream is no longer worth paying for — and shuts it off."

*(Tip: the GPU `job-runner` gives the cleanest on-camera decision. A price agent often closes with
"no signal — gate closed to save budget", which is also a great capital-efficiency story.)*

### 2:10–2:30 — Differentiator + close
> "The whole field is discrete pay-per-request and escrow plumbing. Per-second **streaming**
> settlement was the open lane — and Sluice is live in it: real on-chain payments, a real market
> feed, genuinely autonomous agents, and our own deployed contracts. Sluice — pay by the second,
> settle on Casper, and close the gate the moment you stop."

---

**Editing notes**
- Hold the explorer + registry shots on screen long enough to read (3–4s each).
- Lower-third captions: **275 settlements · 5 agents · 3 providers · 2 deployed contracts**.
- If a LIVE tick hits a transient 500 (testnet finality), just cut it — cadence ≥3s avoids it.
- Keep live runs SHORT: the facilitator allows ~300 requests/day; a few ticks is plenty.
