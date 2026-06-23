/**
 * Deploy an x402-compatible CEP-18 token (the reference Cep18X402.wasm) on Casper testnet,
 * minting the full initial supply to the AGENT account. This sidesteps the WCSPR no-arg
 * attached-value `deposit` (which casper-js-sdk v5 can't build) and gives the agent a token it
 * can stream-pay with via `transfer_with_authorization`. Fully programmatic + reproducible.
 *
 *   npx tsx scripts/deploy-token.ts
 *
 * On success it prints the X402 package hash and writes it to keys/token-package.txt.
 */
import casperSdk from "casper-js-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { rpc, loadAgentKey, csprBalance, fmtCspr, CHAIN_NAME } from "./casper.ts";

const { Args, CLValue } = casperSdk;

const TOKEN_NAME = "Casper X402 Token";
const TOKEN_SYMBOL = "X402";
const DECIMALS = 9;
const INITIAL_SUPPLY = "1000000000000000"; // 1e15 = 1,000,000 X402 (9 decimals)
const PACKAGE_KEY = "X402_package_hash";
const PAYMENT_MOTES = parseInt(process.env.INSTALL_CAP_CSPR || "1200", 10) * 1_000_000_000; // gas cap

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(hash: string): Promise<void> {
  const client = rpc();
  const start = Date.now();
  while (Date.now() - start < 180_000) {
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
  const agent = loadAgentKey();
  const pub = agent.publicKey;
  console.log(`agent: ${pub.toHex()}`);
  console.log(`CSPR balance: ${fmtCspr(await csprBalance(pub))} CSPR`);

  const wasm = new Uint8Array(readFileSync("wasm/Cep18X402.wasm"));
  console.log(`wasm: ${wasm.length} bytes`);

  const args = Args.fromMap({
    name: CLValue.newCLString(TOKEN_NAME),
    symbol: CLValue.newCLString(TOKEN_SYMBOL),
    decimals: CLValue.newCLUint8(DECIMALS),
    initial_supply: CLValue.newCLUInt256(INITIAL_SUPPLY),
    chain_id: CLValue.newCLString("casper:" + CHAIN_NAME),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
    odra_cfg_is_upgrade: CLValue.newCLValueBool(false),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(true),
    odra_cfg_package_hash_key_name: CLValue.newCLString(PACKAGE_KEY),
  });

  const tx = new casperSdk.SessionBuilder()
    .from(pub)
    .chainName(CHAIN_NAME)
    .wasm(wasm)
    .installOrUpgrade()
    .runtimeArgs(args)
    .payment(PAYMENT_MOTES)
    .build();

  tx.sign(agent);
  if (process.env.DRY === "1") {
    console.log("\n[DRY] transaction built + signed OK; not submitting.");
    return;
  }
  const res: any = await rpc().putTransaction(tx);
  const hash = res.transactionHash.toHex();
  console.log(`\ninstall tx: ${hash}`);
  console.log(`https://testnet.cspr.live/deploy/${hash}`);
  process.stdout.write("waiting");
  await waitFor(hash);
  console.log("\n✅ token installed");

  // Read the package hash from the agent account's named keys.
  const pkg = await readPackageHash(pub);
  if (pkg) {
    writeFileSync("keys/token-package.txt", pkg);
    console.log(`X402 package hash: ${pkg}`);
    console.log(`(written to keys/token-package.txt — set ASSET_PACKAGE to this)`);
  } else {
    console.log(`⚠️ installed but could not auto-read ${PACKAGE_KEY}; check the deploy page.`);
  }
}

async function readPackageHash(pub: InstanceType<typeof casperSdk.PublicKey>): Promise<string | null> {
  const client = rpc();
  const blk: any = await client.getLatestBlock();
  const height = blk.block.height as number;
  const id = casperSdk.EntityIdentifier.fromPublicKey(pub);
  const ent: any = await client.getEntityByBlockHeight(id, height);
  const nks = ent.namedKeys?.keys ?? ent.namedKeys ?? [];
  const list = Array.isArray(nks) ? nks : nks.keys ?? [];
  for (const k of list) {
    const name = k.name ?? k.Name;
    if (name === "X402_package_hash") {
      const key = (k.key ?? k.Key ?? "").toString();
      return key.replace(/^.*?([0-9a-f]{64}).*$/i, "$1");
    }
  }
  return null;
}

main().catch((e) => {
  console.error("\n❌", (e as Error).message);
  process.exit(1);
});
