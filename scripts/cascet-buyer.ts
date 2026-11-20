/**
 * Cross-test with CasCet: Sluice's testnet buyer pays for one of CasCet's paid MCP tools over plain
 * x402 HTTP (POST /tools/<name>), scheme "exact", WCSPR on Casper TESTNET, with the same client stack
 * as scripts/pico-x402-buyer.ts (@x402/fetch + @make-software/casper-x402 ExactCasperScheme).
 * CasCet's facilitator submits the transfer and pays its gas.
 *
 *   npx tsx scripts/cascet-buyer.ts [tool]     default get_cspr_market_data
 *
 * Testnet only, with the testnet-only buyer key (never the Sluice agent, which holds mainnet CSPR),
 * and a per-purchase cap (CASCET_MAX_WCSPR, default 10).
 */
import { readFileSync } from "node:fs";
import casperSdk from "casper-js-sdk";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";

const C = casperSdk as any;
const CASCET = (process.env.CASCET_URL || "https://cascet.mericcintosun.com").replace(/\/$/, "");
const KEY_PATH = process.env.CASCET_KEY || "keys/pico-buyer-testnet.pem";
const MAX_MOTES = BigInt(Math.round(Number(process.env.CASCET_MAX_WCSPR || "10") * 1e9));
const NETWORK = "casper:casper-test";
/** WCSPR on Casper testnet (Odra CEP-18 package), one of the assets CasCet's x402 offers name. */
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
/** The Sluice agent account: it pays Sluice's gas and holds real CSPR on mainnet, so it never buys. */
const SLUICE_AGENT_ACCOUNT = "78e91a622946f671f80edcb1c7d67db1a35502161a0d38ca82c9bee9c189c80a";

const buyer = C.PrivateKey.fromPem(readFileSync(KEY_PATH, "utf8"), C.KeyAlgorithm.ED25519);
if (buyer.publicKey.accountHash().toHex() === SLUICE_AGENT_ACCOUNT) throw new Error("refusing: that is the Sluice agent key");

/** Accept only a capped WCSPR payment on Casper testnet. */
function pickOffer(_version: number, accepts: any[]) {
  const ok = accepts.find((a) => a.scheme === "exact" && a.network === NETWORK && String(a.asset).replace(/^hash-/, "") === WCSPR);
  if (!ok) throw new Error(`refusing: no exact WCSPR offer on ${NETWORK} in ${JSON.stringify(accepts).slice(0, 200)}`);
  if (!(BigInt(ok.amount) > 0n && BigInt(ok.amount) <= MAX_MOTES)) throw new Error(`refusing: ${ok.amount} motes is over the ${MAX_MOTES} cap`);
  return ok;
}

const tool = process.argv[2] || "get_cspr_market_data";
const signer = await createClientCasperSigner(KEY_PATH, C.KeyAlgorithm.ED25519);
const client = new x402Client(pickOffer as never).register("casper:*", new ExactCasperScheme(signer));
const http = new x402HTTPClient(client);
const pay = wrapFetchWithPayment(fetch, client);

console.log(`buyer ${signer.accountAddress()} | ${CASCET}/tools/${tool}`);
const started = Date.now();
const res = await pay(`${CASCET}/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const ms = Date.now() - started;
let settled: { transaction?: string; network?: string } | undefined;
try {
  settled = http.getPaymentSettleResponse((n: string) => res.headers.get(n));
} catch {
  // no PAYMENT-RESPONSE header: a refusal, or a server that reports settlement in the body
}
const text = await res.text();
console.log(`HTTP ${res.status} in ${(ms / 1000).toFixed(1)} s`);
if (settled?.transaction) console.log(`settled ${settled.transaction} on ${settled.network}  https://testnet.cspr.live/transaction/${settled.transaction}`);
console.log(`body: ${text.slice(0, 600)}`);
