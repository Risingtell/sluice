/**
 * Deploy the SluiceRegistry contract, register the live streams, and anchor a settlement checkpoint
 * on-chain — turning the off-chain /impact totals into verifiable Casper state.
 *
 *   npx tsx scripts/registry.ts deploy        # install the WASM, save the package hash
 *   npx tsx scripts/registry.ts sync          # register streams + checkpoint current totals
 *   npx tsx scripts/registry.ts read          # read the on-chain values back
 *
 * Uses the same casper-js-sdk flow proven in deploy-token.ts / fund-agents.ts. The deployer (agent
 * key) is the registry owner. WASM path defaults to the Odra build output.
 */
import casperSdk from "casper-js-sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { rpc, loadAgentKey, fmtCspr, csprBalance, CHAIN_NAME } from "./casper.ts";

const { Args, CLValue, Key } = casperSdk;

const WASM = process.env.REGISTRY_WASM || "contracts/sluice_registry/wasm/SluiceRegistry.wasm";
const PKG_FILE = "keys/registry-package.txt";
const PACKAGE_KEY = "sluice_registry_package_hash";
const INSTALL_CAP = parseInt(process.env.INSTALL_CAP_CSPR || "700", 10) * 1_000_000_000;
const CALL_GAS = parseInt(process.env.CALL_CSPR || "5", 10) * 1_000_000_000;

const STREAMS: { id: string; provider: string; rate: string }[] = [
  { id: "btc-usd", provider: "Lumen Markets", rate: "1000000" },
  { id: "eth-usd", provider: "Helios Feeds", rate: "800000" },
  { id: "gpu-telemetry", provider: "NimbusGPU", rate: "2500000" },
];

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

function pkg(): string {
  return (process.env.REGISTRY_PACKAGE || readFileSync(PKG_FILE, "utf8")).trim().replace(/^hash-/, "");
}

async function deploy() {
  const agent = loadAgentKey();
  if (!existsSync(WASM)) throw new Error(`WASM not found at ${WASM} — build the contract first (cargo odra build)`);
  console.log(`deployer: ${agent.publicKey.toHex()} · ${fmtCspr(await csprBalance(agent.publicKey))} CSPR`);
  const wasm = new Uint8Array(readFileSync(WASM));
  console.log(`wasm: ${wasm.length} bytes`);

  const args = Args.fromMap({
    odra_cfg_package_hash_key_name: CLValue.newCLString(PACKAGE_KEY),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(true),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
  });
  const tx = new casperSdk.SessionBuilder()
    .from(agent.publicKey).chainName(CHAIN_NAME).wasm(wasm)
    .installOrUpgrade().runtimeArgs(args).payment(INSTALL_CAP).build();
  tx.sign(agent);
  const res: any = await rpc().putTransaction(tx);
  const hash = res.transactionHash.toHex();
  console.log(`\ninstall tx: https://testnet.cspr.live/deploy/${hash}\nwaiting`);
  await waitFor(hash);

  const blk: any = await rpc().getLatestBlock();
  const id = casperSdk.EntityIdentifier.fromPublicKey(agent.publicKey);
  const ent: any = await rpc().getEntityByBlockHeight(id, blk.block.height);
  const nks = ent.namedKeys?.keys ?? ent.namedKeys ?? [];
  const list = Array.isArray(nks) ? nks : nks.keys ?? [];
  for (const k of list) {
    if ((k.name ?? k.Name) === PACKAGE_KEY) {
      const key = (k.key ?? k.Key ?? "").toString().replace(/^.*?([0-9a-f]{64}).*$/i, "$1");
      writeFileSync(PKG_FILE, key);
      console.log(`\n✅ registry package: ${key}\n(saved to ${PKG_FILE})`);
      return;
    }
  }
  console.log("⚠️ installed but could not auto-read package hash; check the deploy page.");
}

async function call(entry: string, args: InstanceType<typeof Args>) {
  const agent = loadAgentKey();
  const tx = new casperSdk.ContractCallBuilder()
    .from(agent.publicKey).chainName(CHAIN_NAME).byPackageHash(pkg())
    .entryPoint(entry).runtimeArgs(args).payment(CALL_GAS).build();
  tx.sign(agent);
  const res: any = await rpc().putTransaction(tx);
  const hash = res.transactionHash.toHex();
  process.stdout.write(`${entry} → ${hash.slice(0, 12)}… `);
  await waitFor(hash);
  console.log(" ✅");
}

async function sync() {
  const data = JSON.parse(readFileSync(process.env.SNAPSHOT_PATH || "server/.data/impact.json", "utf8"));
  const ev = data.events || [];
  for (const st of STREAMS) {
    await call("register_stream", Args.fromMap({
      stream_id: CLValue.newCLString(st.id),
      provider: CLValue.newCLString(st.provider),
      rate_per_second: CLValue.newCLUInt256(st.rate),
    }));
    const rows = ev.filter((e: any) => e.streamId === st.id);
    const settlements = rows.length;
    const totalPaid = rows.reduce((a: bigint, e: any) => a + BigInt(e.amount || 0), 0n);
    const seconds = Math.round(rows.reduce((a: number, e: any) => a + (e.seconds || 0), 0));
    await call("checkpoint", Args.fromMap({
      stream_id: CLValue.newCLString(st.id),
      settlements: CLValue.newCLUInt64(settlements),
      total_paid: CLValue.newCLUInt256(totalPaid.toString()),
      seconds_streamed: CLValue.newCLUInt64(seconds),
    }));
    console.log(`   ${st.id}: ${settlements} settlements, ${(Number(totalPaid) / 1e9).toFixed(4)} X402 anchored`);
  }
  console.log("\n✅ on-chain registry synced with the proof feed");
}

const cmd = process.argv[2] || "deploy";
(cmd === "deploy" ? deploy() : cmd === "sync" ? sync() : Promise.resolve(console.log("usage: deploy|sync")))
  .catch((e) => { console.error("\n❌", (e as Error).message); process.exit(1); });
