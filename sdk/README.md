# sluice-x402

Rent a continuously-metered resource and pay for it per second via Casper x402, from your own
agent, in a few lines. The SDK wraps the whole exchange: open a session, pay tick-by-tick
(402 challenge, EIP-712 `transfer_with_authorization`, facilitator settle), enforce your budget,
and close the sluice gate the moment your policy says the stream is no longer worth paying for.

```bash
npm install sluice-x402
```

Node 20 or newer, ES modules.

Mock mode needs no keys and pays nothing; it talks to a Sluice server running in mock mode (clone
[the repo](https://github.com/Risingtell/sluice) and run `npm run server`):

```ts
import { Sluice } from "sluice-x402";

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

Live mode pays real ticks from your own Casper account. Without running a server, use the hosted
one (`HOSTED_SERVER`), which takes payment on Casper testnet:

```ts
import { Sluice, HOSTED_SERVER } from "sluice-x402";

const sluice = await Sluice.connect({
  serverUrl: HOSTED_SERVER,
  mode: "live",
  keyPath: "keys/agent.pem", // your funded Casper testnet account (X402 token balance)
});
```

The hosted server runs a faucet that sends X402 test tokens to your account; see the
[main README](https://github.com/Risingtell/sluice#onboard-your-own-agent-no-need-to-ask-us).
Against a server that takes mainnet too, pass `network: "casper:casper"` or
`"casper:casper-test"` to choose; the SDK never picks a server or a network you did not ask for.

## API

| Method | What |
|---|---|
| `Sluice.connect(opts)` | build a client; `mode: "live"` wires the x402 payment signer |
| `listStreams()` | the server's metered catalogue with per-second rates |
| `open(streamId)` | open a session (free; only ticking costs) |
| `payTick(sessionId)` | pay one tick, get the next chunk (+ real tx hash and explorer link when live) |
| `close(sessionId, reason)` | close the gate |
| `stream(streamId, opts)` | the full autonomous loop: budget guard + your `decide()` policy |
| `impact()` | the public proof feed |

The `decide(chunk, ctx)` callback is the agency: it sees every freshly-paid-for chunk plus spend
context (`tick`, `spentMotes`, `nextTickMotes`, `budgetMotes`) and returns whether the stream is
still worth paying for.

Source, server and the MCP server ([`sluice-mcp`](https://www.npmjs.com/package/sluice-mcp)):
[github.com/Risingtell/sluice](https://github.com/Risingtell/sluice). MIT.
