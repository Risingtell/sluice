/**
 * Fund the multi-agent economy: transfer X402 (CEP-18) from agent1 (the holder) to each new
 * consumer agent so they can stream-pay independently. Gas is paid by agent1 (testnet CSPR, free).
 *
 *   npx tsx scripts/fund-agents.ts                 # fund agent2..agent5 with the default amount
 *   AMOUNT_X402=50000 npx tsx scripts/fund-agents.ts
 *   DRY=1 npx tsx scripts/fund-agents.ts           # build + sign only, don't submit
 *
 * Recipients default to the account hashes of keys/agent2.pem .. keys/agent5.pem.
 */
import casperSdk from "casper-js-sdk";
import { readFileSync, existsSync } from "node:fs";
import { rpc, loadAgentKey, csprBalance, fmtCspr, CHAIN_NAME } from "./casper.ts";

const { Args, CLValue, Key, PrivateKey, KeyAlgorithm } = casperSdk;

const DECIMALS = 9n;
const AMOUNT = BigInt(process.env.AMOUNT_X402 || "100000") * 10n ** DECIMALS; // default 100,000 X402
const GAS_MOTES = parseInt(process.env.GAS_CSPR || "5", 10) * 1_000_000_000;
const TARGET_KEYS = (process.env.TARGETS || "agent2,agent3,agent4,agent5").split(",");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pkg(): string {
  const fromEnv = (process.env.ASSET_PACKAGE || "").replace(/^hash-/, "");
  if (fromEnv) return fromEnv;
  return readFileSync("keys/token-package.txt", "utf8").trim().replace(/^hash-/, "");
}

function accountHashOf(name: string): string {
  const pem = readFileSync(`keys/${name}.pem`, "utf8");
  const pk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  return pk.publicKey.accountHash().toHex().replace(/^account-hash-/, "");
}

async function waitFor(hash: string): Promise<void> {
  const client = rpc();
  const start = Date.now();
  while (Date.now() - start < 150_000) {
    try {
      const info: any = await client.getTransactionByTransactionHash(hash);
      const exec = info.executionInfo;
      if (exec && exec.blockHeight !== 0 && exec.executionResult) {
        const err = exec.executionResult.errorMessage;
        if (err) throw new Error(`execution failed: ${err}`);
        return;
      }
    } catch (e) {
      if ((e as Error).message.includes("execution failed")) throw e;
    }
    process.stdout.write(".");
    await sleep(4000);
  }
  throw new Error(`timed out waiting for ${hash}`);
}

async function main() {
  const holder = loadAgentKey();
  const pkgHash = pkg();
  console.log(`holder:  ${holder.publicKey.toHex()}`);
  console.log(`CSPR:    ${fmtCspr(await csprBalance(holder.publicKey))}`);
  console.log(`token:   ${pkgHash}`);
  console.log(`amount:  ${AMOUNT} motes (${AMOUNT / 10n ** DECIMALS} X402) per agent → ${TARGET_KEYS.join(", ")}\n`);

  for (const name of TARGET_KEYS) {
    if (!existsSync(`keys/${name}.pem`)) { console.log(`skip ${name} (no key)`); continue; }
    const ah = accountHashOf(name);
    const recipient = CLValue.newCLKey(Key.newKey(`account-hash-${ah}`));
    const args = Args.fromMap({ recipient, amount: CLValue.newCLUInt256(AMOUNT.toString()) });

    const tx = new casperSdk.ContractCallBuilder()
      .from(holder.publicKey)
      .chainName(CHAIN_NAME)
      .byPackageHash(pkgHash)
      .entryPoint("transfer")
      .runtimeArgs(args)
      .payment(GAS_MOTES)
      .build();
    tx.sign(holder);

    if (process.env.DRY === "1") { console.log(`[DRY] ${name} (${ah.slice(0, 10)}…) tx built+signed OK`); continue; }

    const res: any = await rpc().putTransaction(tx);
    const hash = res.transactionHash.toHex();
    process.stdout.write(`${name} ${ah.slice(0, 10)}… → tx ${hash.slice(0, 12)}… `);
    await waitFor(hash);
    console.log(" ✅");
  }
  console.log("\ndone.");
}

main().catch((e) => { console.error("\n❌", (e as Error).message); process.exit(1); });
