/**
 * Minimal SDK example: an agent rents the BTC/USD stream, pays per tick, and closes the gate
 * the moment it has what it needs. Zero credentials in mock mode.
 *
 *   npm run server            # terminal 1 (mock)
 *   npx tsx examples/rent-a-stream.ts   # terminal 2
 *
 * Live mode (real on-chain settlement per tick):
 *   MODE=live npm run server
 *   SLUICE_MODE=live CLIENT_PRIVATE_KEY_PATH=keys/agent.pem npx tsx examples/rent-a-stream.ts
 */
import { config as loadEnv } from "dotenv";
import { Sluice } from "../sdk/index.ts";

loadEnv();

const live = process.env.SLUICE_MODE === "live";
const sluice = await Sluice.connect({
  serverUrl: process.env.SLUICE_SERVER_URL || "http://localhost:4021",
  mode: live ? "live" : "mock",
  keyPath: process.env.CLIENT_PRIVATE_KEY_PATH,
});

console.log(`agent ${sluice.agentId} renting btc-usd (${live ? "LIVE" : "mock"})`);

const summary = await sluice.stream("btc-usd", {
  budgetX402: 0.03,
  maxTicks: 5,
  tickMs: live ? 2000 : 500,
  // The agency: stop paying as soon as we have three fresh quotes.
  decide: (chunk, ctx) => ({
    keepStreaming: ctx.tick < 3,
    reason: ctx.tick < 3 ? `collected quote ${ctx.tick}: ${chunk.price}` : "have enough quotes, gate closed",
  }),
  onTick: ({ tick, data, txHash }) =>
    console.log(
      `  tick ${tick}: ${JSON.stringify(data)}` +
        (txHash ? `\n    ${live ? "settled on-chain" : "simulated settlement"}: ${txHash}` : ""),
    ),
});

console.log(
  `done: ${summary.ticks} ticks, ${(Number(summary.totalPaidMotes) / 1e9).toFixed(6)} X402, ` +
    `closed because "${summary.closeReason}"` +
    (summary.txHashes.length ? `, ${summary.txHashes.length} ${live ? "on-chain" : "simulated"} settlements` : ""),
);
