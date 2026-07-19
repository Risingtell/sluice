# @sluice/x402 - client SDK

Rent a continuously-metered resource and pay for it per second via Casper x402, from your own
agent, in a few lines. The SDK wraps the whole exchange: open a session, pay tick-by-tick
(402 challenge, EIP-712 `transfer_with_authorization`, facilitator settle), enforce your budget,
and close the sluice gate the moment your policy says the stream is no longer worth paying for.

```ts
import { Sluice } from "./sdk/index.ts";

// mock: zero credentials. live: pass mode + your Casper key.
const sluice = await Sluice.connect({ serverUrl: "http://localhost:4021" });

const summary = await sluice.stream("btc-usd", {
  budgetX402: 0.05,
  decide: (chunk, ctx) => ({
    keepStreaming: ctx.tick < 5 && chunk.price < 70000,
    reason: `price ${chunk.price}`,
  }),
  onTick: ({ tick, txHash }) => console.log(`tick ${tick} settled: ${txHash}`),
});

console.log(summary.closeReason, summary.txHashes);
```

Live mode:

```ts
const sluice = await Sluice.connect({
  serverUrl: "https://sluice-kff3.onrender.com",
  mode: "live",
  keyPath: "keys/agent.pem", // funded Casper testnet account (X402 token balance)
});
```

## API

| Method | What |
|---|---|
| `Sluice.connect(opts)` | build a client; `mode: "live"` wires the x402 payment signer |
| `listStreams()` | the server's metered catalogue with per-second rates |
| `open(streamId)` | open a session (free; only ticking costs) |
| `payTick(sessionId)` | pay one tick, get the next chunk (+ real tx hash when live) |
| `close(sessionId, reason)` | close the gate |
| `stream(streamId, opts)` | the full autonomous loop: budget guard + your `decide()` policy |
| `impact()` | the public proof feed |

The `decide(chunk, ctx)` callback is the agency: it sees every freshly-paid-for chunk plus spend
context (`tick`, `spentMotes`, `nextTickMotes`, `budgetMotes`) and returns whether the stream is
still worth paying for. Runnable example: [`examples/rent-a-stream.ts`](../examples/rent-a-stream.ts).
