/**
 * A buyer that pays its own gas: streams a few ticks from a Sluice server using buyer-settle, so
 * each tick's CEP-18 transfer is submitted (and its gas paid) by this agent, never by the server.
 *
 *   SERVER_URL=http://localhost:4021 BUYER_KEY=keys/agent2.pem npx tsx scripts/buyer-settle-run.ts
 *
 * Env: SERVER_URL (default http://localhost:4021), BUYER_KEY (default keys/agent2.pem),
 * NETWORK (default casper:casper-test), STREAM (default eth-usd), TICKS (default 3).
 * Pays on testnet unless NETWORK says otherwise.
 */
import { Sluice } from "../sdk/index.ts";

const serverUrl = process.env.SERVER_URL || "http://localhost:4021";
const network = process.env.NETWORK || "casper:casper-test";
const stream = process.env.STREAM || "eth-usd";
const ticks = Number(process.env.TICKS || 3);
const cspr = (m: bigint) => (Number(m) / 1e9).toFixed(4);

const health = (await (await fetch(`${serverUrl}/health`)).json()) as { buyerSettleNetworks?: string[]; sponsoredNetworks?: string[] };
console.log(`server ${serverUrl}: buyer-settle on ${health.buyerSettleNetworks?.join(", ") || "none"}, server pays on ${health.sponsoredNetworks?.join(", ") || "none"}`);

const sluice = await Sluice.connect({ serverUrl, mode: "live", network, keyPath: process.env.BUYER_KEY || "keys/agent2.pem", payGas: true });
console.log(`buyer ${sluice.agentId} streaming ${stream} on ${network}, paying its own gas`);

const summary = await sluice.stream(stream, {
  maxTicks: ticks,
  tickMs: 1000,
  budgetX402: 1,
  onTick: (t) => console.log(`tick ${t.tick}: tx ${t.transactionHash} | billed ${t.billedSeconds.toFixed(1)} s | ${t.settleMs} ms | gas ${cspr(t.gasMotes)} CSPR`),
});
console.log(`closed: ${summary.closeReason}`);
console.log(`ticks ${summary.ticks}, paid ${cspr(summary.totalPaidMotes)} X402, gas paid by buyer ${cspr(summary.gasPaidMotes)} CSPR`);
console.log(`settlement ms: ${JSON.stringify(summary.settlement)}`);
for (const h of summary.transactionHashes) console.log(`  https://testnet.cspr.live/transaction/${h}`);
if (summary.transactionHashes.length === 0 || summary.closeReason.startsWith("stream interrupted")) process.exit(1);
