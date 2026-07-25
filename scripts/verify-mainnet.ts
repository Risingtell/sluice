/**
 * Mainnet verifier: confirm every claimed Casper MAINNET settlement really executed on-chain.
 *
 * Sluice's mainnet claim is small and exact, so it is checked exactly: each settlement in
 * data/mainnet-settlements.json is looked up by transaction hash against a public Casper mainnet
 * node and must report an execution result with no error. A reverted transfer still has a hash, so
 * the hash alone proves nothing; the execution result is what proves it.
 *
 * Needs no API key and no account: it talks to the public mainnet JSON-RPC endpoint directly.
 *
 *   npm run verify:mainnet
 */
import { readFileSync } from "node:fs";

const RPC = process.env.MAINNET_RPC_URL || "https://node.mainnet.casper.network/rpc";
const FILE = "data/mainnet-settlements.json";

interface Settlement {
  txHash: string;
  streamId?: string;
  provider?: string;
  amount?: string;
}

async function main(): Promise<void> {
  const doc = JSON.parse(readFileSync(FILE, "utf8")) as {
    network: string;
    assetPackage: string;
    explorer: string;
    settlements: Settlement[];
  };

  console.log(`Verifying ${doc.settlements.length} claimed settlements on ${doc.network} against ${RPC}\n`);

  const casperMod = await import("casper-js-sdk");
  const sdk = (casperMod as any).default ?? casperMod;
  const client = new sdk.RpcClient(new sdk.HttpHandler(RPC));

  let ok = 0;
  const failures: string[] = [];

  for (const s of doc.settlements) {
    try {
      const info: any = await client.getTransactionByTransactionHash(s.txHash);
      const exec = info.executionInfo;
      const err = exec?.executionResult?.errorMessage;
      if (!exec || exec.blockHeight === undefined) {
        failures.push(`${s.txHash} is not on mainnet`);
        console.log(`  MISSING  ${s.txHash.slice(0, 18)}`);
        continue;
      }
      if (err) {
        failures.push(`${s.txHash} reverted: ${err}`);
        console.log(`  REVERTED ${s.txHash.slice(0, 18)} ${err}`);
        continue;
      }
      ok++;
      const amt = s.amount ? (Number(s.amount) / 1e9).toFixed(6) : "";
      console.log(`  OK       ${s.txHash.slice(0, 18)} block ${exec.blockHeight}  ${String(s.streamId ?? "").padEnd(14)} ${amt} X402`);
    } catch (e) {
      failures.push(`${s.txHash} lookup failed: ${(e as Error).message}`);
      console.log(`  ERROR    ${s.txHash.slice(0, 18)} ${(e as Error).message.slice(0, 60)}`);
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`FAILED: ${failures.length} of ${doc.settlements.length} claimed mainnet settlements did not verify.`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
    return;
  }

  const total = doc.settlements.reduce((n, s) => n + BigInt(s.amount || "0"), 0n);
  console.log(`VERIFIED: all ${ok} settlements executed on Casper mainnet with no error.`);
  console.log(`   Token: ${doc.explorer}/contract-package/${doc.assetPackage}`);
  console.log(`   Streamed value: ${(Number(total) / 1e9).toFixed(6)} X402 across ${new Set(doc.settlements.map((s) => s.streamId)).size} streams.`);
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  process.exit(1);
});
