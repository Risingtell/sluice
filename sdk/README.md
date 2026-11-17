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
  onTick: ({ tick, transactionHash, settleMs }) =>
    console.log(`tick ${tick} settled in ${settleMs} ms: ${transactionHash}`),
});

console.log(summary.closeReason, summary.transactionHashes, summary.settlement);
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

**Who pays the gas.** Each tick is one CEP-18 transfer, and its gas (about 3.3 CSPR) is paid by
whoever submits it. A server can submit it for you (`exact`), or ask you to submit it from your own
account (`buyer-settle`). Mainnet Sluice servers do not pay gas for buyers.

```ts
const sluice = await Sluice.connect({ mode: "live", keyPath, serverUrl, payGas: true });
const summary = await sluice.stream("btc-usd", { maxTicks: 5, gasBudgetCSPR: 20 });
console.log(summary.gasPaidMotes); // gas this agent paid, in motes
```

`payGas: true` always pays its own gas and refuses a server that does not offer it; `false` accepts
only servers that pay it; unset takes the server's offer where there is one, otherwise pays. Your
account needs CSPR for gas as well as the payment token. `gasLimitMotes` (default 5 CSPR) caps each
transfer, `rpcUrls` picks the node per network, each tick reports `gasMotes`, and `gasBudgetCSPR`
stops a session before its gas crosses a ceiling. If a server refuses a tick after your transfer
executed, the error names the transaction hash.

**Paying on mainnet.** Mainnet Sluice servers are paid in WCSPR (Wrapped CSPR, 1:1 with CSPR).
Buy CSPR (Casper Wallet's Buy, cspr.live, or an exchange), then wrap it from the same account:

```ts
await sluice.wrapCspr(10, "casper:casper");   // 10 CSPR -> 10 WCSPR, about 3.2 CSPR of gas
await sluice.unwrapCspr(2, "casper:casper");  // back to CSPR when you are done
```

`WCSPR_MAINNET` and `WCSPR_TESTNET` export the token package hashes.

## API

| Method | What |
|---|---|
| `Sluice.connect(opts)` | build a client; `mode: "live"` wires the x402 payment signer |
| `listStreams()` | the server's metered catalogue with per-second rates |
| `open(streamId)` | open a session (free; only ticking costs) |
| `payTick(sessionId)` | pay one tick, get the next chunk (+ `transactionHash`, explorer link, `settleMs` and `gasMotes` when live) |
| `close(sessionId, reason)` | close the gate |
| `stream(streamId, opts)` | the full autonomous loop: budget guard + your `decide()` policy |
| `impact()` | the public proof feed |

The `decide(chunk, ctx)` callback is the agency: it sees every freshly-paid-for chunk plus spend
context (`tick`, `spentMotes`, `nextTickMotes`, `budgetMotes`) and returns whether the stream is
still worth paying for.

**Timing.** In live mode each tick waits for its own on-chain settlement: 4-11 s on Casper
testnet, about 7 s median (measured by an outside agent). So ticks land every settlement time +
`tickMs`, and that is the real billing resolution, not one second. `tickMs` (default 2000) is a
pause before each tick, not a tick rate. Each tick bills the actual time since the previous one,
so time spent settling is billed once, in the next tick. The server caps a single tick (10 s by
default) and does not bill time past the cap. `onTick` gives each tick's `settleMs` (the whole paid
request, mostly settlement) and `billedSeconds`; in live mode the summary's `settlement` holds
min/median/max. In mock mode hashes are synthetic.

**Hashes.** Settlements are Casper 2.0 Version1 transactions. Look one up over RPC with
`info_get_transaction` and `{"Version1": hash}` (`info_get_deploy` answers "No such deploy").
`transactionHash` / `transactionHashes` are the names to use; `txHash` / `txHashes` hold the same
values for code written against 0.1.0.

Source, server and the MCP server ([`sluice-mcp`](https://www.npmjs.com/package/sluice-mcp)):
[github.com/Risingtell/sluice](https://github.com/Risingtell/sluice). MIT.
