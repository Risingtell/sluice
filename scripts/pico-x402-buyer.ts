/**
 * Cross-test with Pico, round two: the same agent test links, bought over standard x402 (scheme
 * "exact", WCSPR on Casper TESTNET) with the very client stack Sluice's own agents use
 * (@x402/fetch + @make-software/casper-x402 ExactCasperScheme). Pico's buyer did the reverse
 * against Sluice on 9 Nov 2026.
 *
 *   npx tsx scripts/pico-x402-buyer.ts wrap <CSPR>     wrap test CSPR into WCSPR (Pico prices in WCSPR)
 *   npx tsx scripts/pico-x402-buyer.ts                 buy every "Agent test link" Pico lists
 *   npx tsx scripts/pico-x402-buyer.ts <linkId> ...    buy the given links
 *
 * WCSPR is an Odra contract whose `deposit` is payable, so wrapping runs Odra's proxy caller
 * session wasm (ODRA_PROXY_CALLER_WASM: resources/proxy_caller_with_return.wasm from the
 * odra-casper-rpc-client 2.9.0 crate on crates.io).
 *
 * Money safety: testnet only (every quote and deploy is checked for casper-test), a test-only
 * wallet (PICO_KEY, default keys/pico-buyer-testnet.pem), never the Sluice agent key, which also
 * holds mainnet CSPR, and a per-purchase cap (PICO_MAX_WCSPR, default 30).
 */
import { readFileSync } from "node:fs";
import casperSdk from "casper-js-sdk";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";

const C = casperSdk as any;
const PICO = (process.env.PICO_URL || "https://pico-payment-casper.vercel.app").replace(/\/$/, "");
const KEY_PATH = process.env.PICO_KEY || "keys/pico-buyer-testnet.pem";
const MAX_MOTES = BigInt(Math.round(Number(process.env.PICO_MAX_WCSPR || "30") * 1e9));
const RPC = "https://node.testnet.casper.network/rpc";
const CHAIN = "casper-test";
const NETWORK = "casper:casper-test";
/** WCSPR on Casper testnet (Odra CEP-18 package), the asset Pico's x402 offers name. */
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
/** The Sluice agent account: it pays Sluice's gas and holds real CSPR on mainnet, so it never buys. */
const SLUICE_AGENT_ACCOUNT = "78e91a622946f671f80edcb1c7d67db1a35502161a0d38ca82c9bee9c189c80a";

const buyer = C.PrivateKey.fromPem(readFileSync(KEY_PATH, "utf8"), C.KeyAlgorithm.ED25519);
if (buyer.publicKey.accountHash().toHex() === SLUICE_AGENT_ACCOUNT) throw new Error("refusing: that is the Sluice agent key");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpcCall(method: string, params: unknown): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = (await res.json()) as { result?: any; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const cspr = (motes: bigint | string) => (Number(BigInt(motes)) / 1e9).toFixed(4);

async function balance(): Promise<bigint> {
  const r = await rpcCall("query_balance", { purse_identifier: { main_purse_under_public_key: buyer.publicKey.toHex() } });
  return BigInt(r.balance);
}

/** Wrap test CSPR into WCSPR through Odra's proxy caller (a payable call needs session wasm). */
async function wrap(amountCspr: number) {
  if (!(amountCspr > 0 && amountCspr <= 100)) throw new Error("wrap 0-100 CSPR at a time");
  const wasmPath = process.env.ODRA_PROXY_CALLER_WASM;
  if (!wasmPath) throw new Error("set ODRA_PROXY_CALLER_WASM to proxy_caller_with_return.wasm");
  const motes = BigInt(Math.round(amountCspr * 1e9)).toString();
  const gas = "10000000000"; // 10 CSPR limit; Casper refunds part of the unused gas

  const args = C.Args.fromMap({
    package_hash: C.CLValue.newCLByteArray(Uint8Array.from(Buffer.from(WCSPR, "hex"))),
    entry_point: C.CLValue.newCLString("deposit"),
    // The entry point's own serialized RuntimeArgs: none, which is a zero u32 count.
    args: C.CLValue.newCLList(C.CLTypeUInt8, [0, 0, 0, 0].map((b) => C.CLValue.newCLUint8(b))),
    attached_value: C.CLValue.newCLUInt512(motes),
    amount: C.CLValue.newCLUInt512(motes),
  });
  const session = C.ExecutableDeployItem.newModuleBytes(Uint8Array.from(readFileSync(wasmPath)), args);
  const payment = C.ExecutableDeployItem.standardPayment(gas);
  const header = C.DeployHeader.default();
  header.account = buyer.publicKey;
  header.chainName = CHAIN;
  const deploy = C.Deploy.makeDeploy(header, payment, session);
  if (deploy.header.chainName !== CHAIN) throw new Error(`refusing: deploy built for ${deploy.header.chainName}`);
  deploy.sign(buyer);

  console.log(`wrapping ${amountCspr} test CSPR (balance ${cspr(await balance())})`);
  const rpc = new C.RpcClient(new C.HttpHandler(RPC));
  const put = await rpc.putDeploy(deploy);
  const hash: string = put.deployHash?.toHex?.() ?? String(put.deployHash);
  console.log(`sent    https://testnet.cspr.live/transaction/${hash}`);
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const info = await rpcCall("info_get_deploy", { deploy_hash: hash }).catch(() => null);
    const exec = info?.execution_info?.execution_result?.Version2;
    if (!exec) continue;
    if (exec.error_message) throw new Error(`wrap failed: ${exec.error_message}`);
    console.log(`wrapped, block ${info.execution_info.block_height}, gas consumed ${cspr(exec.consumed)} CSPR, balance now ${cspr(await balance())}`);
    return;
  }
  throw new Error("timed out waiting for the wrap to execute");
}

/** Accept only a capped WCSPR payment on Casper testnet. */
function pickOffer(_version: number, accepts: any[]) {
  const ok = accepts.find((a) => a.scheme === "exact" && a.network === NETWORK && String(a.asset).replace(/^hash-/, "") === WCSPR);
  if (!ok) throw new Error(`refusing: no exact WCSPR offer on ${NETWORK} in ${JSON.stringify(accepts).slice(0, 200)}`);
  if (!(BigInt(ok.amount) > 0n && BigInt(ok.amount) <= MAX_MOTES)) throw new Error(`refusing: ${ok.amount} is over the cap`);
  return ok;
}

async function buyAll(ids: string[]) {
  const signer = await createClientCasperSigner(KEY_PATH, C.KeyAlgorithm.ED25519);
  const client = new x402Client(pickOffer as never).register("casper:*", new ExactCasperScheme(signer));
  const http = new x402HTTPClient(client);
  const pay = wrapFetchWithPayment(fetch, client);

  if (!ids.length) {
    const d = (await (await fetch(`${PICO}/api/casper/discover`)).json()) as { items: { id: string; title: string }[] };
    ids = d.items.filter((i) => /agent test link/i.test(i.title)).map((i) => i.id);
  }
  console.log(`buyer ${signer.accountAddress()} | ${ids.length} link(s) | CSPR ${cspr(await balance())}`);

  for (const id of ids) {
    const url = `${PICO}/api/content/${id}`;
    const started = Date.now();
    const res = await pay(url);
    const ms = Date.now() - started;
    const settled = http.getPaymentSettleResponse((n: string) => res.headers.get(n));
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    console.log(`\n${id}: HTTP ${res.status} in ${(ms / 1000).toFixed(1)} s`);
    if (settled?.transaction) console.log(`  settled ${settled.transaction} on ${settled.network}  https://testnet.cspr.live/transaction/${settled.transaction}`);
    const secret = JSON.stringify(body).match(/"secret[^"]*"\s*:\s*"([^"]+)"/i)?.[1];
    if (secret) console.log(`  secret word: ${secret}`);
    console.log(`  body: ${JSON.stringify(body).slice(0, 400)}`);
  }
  console.log(`\nCSPR left ${cspr(await balance())}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "wrap") await wrap(Number(rest[0]));
else await buyAll([cmd, ...rest].filter(Boolean));
