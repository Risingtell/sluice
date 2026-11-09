/**
 * Cross-test with Pico, another Casper Forward project: an agent buys Pico content per request
 * through Pico's x402-style 402 flow, paying native CSPR on Casper TESTNET.
 *
 *   npx tsx scripts/pico-buyer.ts                 buys every "Agent test link" in Pico's catalogue
 *   npx tsx scripts/pico-buyer.ts <linkId> ...    buys the given links
 *
 * Money safety: it pays only when Pico's quote names casper-test, signs with a test-only wallet
 * (PICO_KEY, default keys/pico-buyer-testnet.pem) and refuses the Sluice agent key, which also holds
 * mainnet CSPR. Each purchase is capped (PICO_MAX_CSPR, default 30), and a page is never paid twice:
 * while a payment settles, the request is retried with the same deploy hash.
 */
import { readFileSync } from "node:fs";
import casperSdk from "casper-js-sdk";

const C = casperSdk as any;
const PICO = (process.env.PICO_URL || "https://pico-payment-casper.vercel.app").replace(/\/$/, "");
const KEY_PATH = process.env.PICO_KEY || "keys/pico-buyer-testnet.pem";
const MAX_MOTES = BigInt(Math.round(Number(process.env.PICO_MAX_CSPR || "30") * 1e9));
const RPC = "https://node.testnet.casper.network/rpc";
const CHAIN = "casper-test";
/** The Sluice agent account: it pays Sluice's gas and holds real CSPR on mainnet, so it never buys. */
const SLUICE_AGENT_ACCOUNT = "78e91a622946f671f80edcb1c7d67db1a35502161a0d38ca82c9bee9c189c80a";

interface Quote {
  scheme: string;
  network: string;
  payTo: string;
  asset: string;
  amountMotes: string;
  amountCspr?: string;
  priceUsd?: string | number;
  transferId: number;
}

const buyer = C.PrivateKey.fromPem(readFileSync(KEY_PATH, "utf8"), C.KeyAlgorithm.ED25519);
if (buyer.publicKey.accountHash().toHex() === SLUICE_AGENT_ACCOUNT) throw new Error("refusing: that is the Sluice agent key");
const rpc = new C.RpcClient(new C.HttpHandler(RPC));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

async function balanceCspr(): Promise<number> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query_balance", params: { purse_identifier: { main_purse_under_public_key: buyer.publicKey.toHex() } } }),
    signal: AbortSignal.timeout(30000),
  });
  const j = (await res.json()) as { result?: { balance: string } };
  return j.result ? Number(BigInt(j.result.balance)) / 1e9 : 0;
}

/** Validate Pico's quote and refuse anything that is not a capped native transfer on testnet. */
function checkQuote(q: Quote | undefined): Quote {
  if (!q) throw new Error("no payment requirements in the 402");
  if (q.scheme !== "casper-native-transfer") throw new Error(`unexpected scheme ${q.scheme}`);
  if (q.network !== CHAIN) throw new Error(`refusing: Pico asks for ${q.network}, this buyer pays on ${CHAIN} only`);
  if (q.asset && q.asset !== "CSPR") throw new Error(`unexpected asset ${q.asset}`);
  if (!/^0[12][0-9a-f]{64,66}$/i.test(q.payTo)) throw new Error("payTo is not a Casper public key");
  if (!(BigInt(q.amountMotes) > 0n && BigInt(q.amountMotes) <= MAX_MOTES)) throw new Error(`refusing: ${q.amountMotes} motes is over the cap`);
  if (!Number.isSafeInteger(q.transferId) || q.transferId < 0) throw new Error("bad transferId");
  return q;
}

async function pay(q: Quote): Promise<string> {
  const deploy = C.makeCsprTransferDeploy({
    senderPublicKeyHex: buyer.publicKey.toHex(),
    recipientPublicKeyHex: q.payTo,
    transferAmount: q.amountMotes,
    chainName: CHAIN,
    memo: String(q.transferId),
  });
  if (deploy.header.chainName !== CHAIN) throw new Error(`refusing: deploy built for ${deploy.header.chainName}`);
  deploy.sign(buyer);
  const put = await rpc.putDeploy(deploy);
  return put.deployHash?.toHex?.() ?? String(put.deployHash);
}

async function buy(linkId: string) {
  const url = `${PICO}/api/casper/content/${linkId}`;
  const quoteRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (quoteRes.status !== 402) throw new Error(`expected 402, got ${quoteRes.status}`);
  const q = checkQuote(((await quoteRes.json()) as { accepts?: Quote[] }).accepts?.[0]);

  const paidAt = now();
  const hash = await pay(q);
  // Redeem with the same deploy hash until Pico confirms it; a 402 here means "do not pay again, stop".
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const res = await fetch(url, { headers: { "X-Casper-Deploy-Hash": hash }, signal: AbortSignal.timeout(30000) });
    if (res.status === 202) continue;
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      return { linkId, priceUsd: q.priceUsd, cspr: Number(BigInt(q.amountMotes)) / 1e9, deploy: hash, unlockSeconds: Math.round((now() - paidAt) / 1000), status: res.status, title: body.title, contentUrl: body.contentUrl };
    }
    return { linkId, priceUsd: q.priceUsd, cspr: Number(BigInt(q.amountMotes)) / 1e9, deploy: hash, status: res.status, error: body.error ?? "redeem failed" };
  }
  return { linkId, deploy: hash, status: "timeout", error: "not confirmed within 200 s" };
}

async function main() {
  let ids = process.argv.slice(2);
  if (!ids.length) {
    const d = (await (await fetch(`${PICO}/api/casper/discover`, { signal: AbortSignal.timeout(30000) })).json()) as { items?: { id: string; title: string }[] };
    ids = (d.items ?? []).filter((i) => /^agent test link/i.test(i.title)).map((i) => i.id);
  }
  console.log(`buyer ${buyer.publicKey.toHex().slice(0, 10)}… on ${CHAIN}: ${await balanceCspr()} test CSPR, ${ids.length} link(s) to buy`);
  const results = [];
  for (const id of ids) {
    try {
      const r = await buy(id);
      results.push(r);
      console.log(JSON.stringify(r));
    } catch (e) {
      results.push({ linkId: id, error: (e as Error).message });
      console.log(JSON.stringify({ linkId: id, error: (e as Error).message }));
    }
  }
  console.log(`done; buyer now holds ${await balanceCspr()} test CSPR`);
  for (const r of results) if ((r as { deploy?: string }).deploy) console.log(`https://testnet.cspr.live/deploy/${(r as { deploy: string }).deploy}`);
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  process.exit(1);
});
