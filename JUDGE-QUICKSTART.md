# Judge quickstart: verify every claim in under 5 minutes

Sluice's core claim: **real per-second streaming payments, settled on-chain via Casper x402, by
autonomous agents that close their own stream.** Here is the fastest path to verify each part
yourself. Nothing below needs an account, a key, or any setup beyond Node 20+.

## 0. Run the real thing yourself (90 seconds, browser only)

Open **https://sluice-kff3.onrender.com/demo.html** and press **Run autonomous agent**.
A real agent session runs server-side and streams to your screen: each tick is an x402
settlement, and while the daily live budget lasts, every tick lands as a real CEP-18 transfer
on Casper testnet with a clickable cspr.live link, in front of you. When the live budget is
spent the page says so plainly and runs the same meter and policy code with simulated
settlement. (Free hosting: the first request may take up to a minute to wake the server.)

## 1. The proof feed is real (60 seconds, browser only)

- Open the live proof page: **https://risingtell.github.io/sluice/impact.html**
- Click any transaction hash in the settlements table. It opens the real deploy on
  **testnet.cspr.live**: a CEP-18 `transfer_with_authorization` moving the X402 token from an
  agent's account to a provider's account, gas paid by the x402 facilitator's sponsored feePayer.
- Both of our own deployed contracts, live on Casper testnet:
  - CEP-18 `X402` token (every settlement moves it):
    [`658bb84b...`](https://testnet.cspr.live/contract-package/658bb84ba4aa82ffc98a55e0f8c447103dd9d4a28fb32fca3363aa0e1300017e)
  - `SluiceRegistry` (anchors stream terms + settlement checkpoints on-chain):
    [`a7cbd09c...`](https://testnet.cspr.live/contract-package/a7cbd09cc9f99216141ede2dd063c57208e94ee0ca62780e3194beb05cf352cc)

## 2. The numbers are not inflated (2 minutes, zero credentials)

```bash
git clone https://github.com/Risingtell/sluice && cd sluice
npm install
npm run verify
```

This re-derives the totals **from the Casper token ledger itself**, independent of our server and
our feed: it reads every X402 transfer, counts agent-to-provider payments, and compares against
what the public feed claims. Expected result: the chain shows **at least** as many settlements as
the feed claims (currently chain 307, feed 289). Sluice never over-claims.

With no key it verifies against the committed ledger snapshot in `data/onchain-actions.json`
(the same raw data, refreshed at every keyed run). To re-pull the ledger live, set
`FACILITATOR_API_KEY` to a free key from console.cspr.cloud.

## 3. The streaming meter works (2 minutes, zero credentials)

```bash
cp .env.template .env
npm run server        # terminal 1: http://localhost:4021, dashboard at /impact.html
AGENT_TICK_MS=300 AGENT_MAX_TICKS=12 npm run agent   # terminal 2
```

Watch the agent open a session, pay per tick, evaluate the streamed data against its objective,
and close the gate on its own with a stated reason. This MOCK mode runs the exact same streaming
meter and agent policy code as LIVE, with settlement simulated (and kept in a separate snapshot,
so simulated events never touch the on-chain proof data).

## 4. The live x402 loop (what the demo video shows)

The full live loop (agent signs EIP-712 per tick, hosted facilitator settles a real CEP-18
transfer on `casper:casper-test`) needs a funded testnet key and a facilitator API key, so we
do not ask judges to run it. It is shown end-to-end in the demo video and every settlement it
has ever produced is in the feed you verified in step 2:

- Demo video: https://youtu.be/C_0LxnopK00
- Live wiring: `server/src/casper-live.ts` (server side), `agent/src/index.ts` (agent side)

## 5. Consume it from your own agent (optional, 2 minutes)

With the mock server from step 3 still running:

```bash
npx tsx examples/rent-a-stream.ts    # an SDK agent rents btc-usd, pays per tick, self-closes
```

And Sluice speaks MCP: `npx tsx mcp/server.ts` exposes `list_streams` / `open_session` /
`pay_tick` / `close_session` / `get_proof` to any MCP-capable AI agent, so an LLM can rent and
pay for a stream itself. See [`sdk/README.md`](sdk/README.md) and [`mcp/README.md`](mcp/README.md).

## What each step proved

| Step | Claim verified |
|---|---|
| 1 | Settlements are real on-chain CEP-18 transfers; both contracts are deployed and ours |
| 2 | The published totals are backed 1:1 by the Casper ledger; no over-claiming |
| 3 | The per-second meter, gate cutoff, and autonomous agent decisions actually work |
| 4 | The same code runs the real x402 settlement loop on Casper testnet |
