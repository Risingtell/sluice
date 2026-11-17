/**
 * Buyer-settle: the buyer submits its own transfer and pays its own gas; the server only reads the
 * chain. These tests pin what the server accepts as payment, that one transfer pays one tick only,
 * and that mainnet is never sponsored by default.
 *
 *   npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/src/store.ts";
import type { AddressInfo } from "node:net";
import express from "express";
import casperSdk from "casper-js-sdk";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { checkSettlement, claimMessage, readExecution, SCHEME_BUYER_SETTLE, type SettlementCheck, type SettlementExpectation } from "../shared/buyer-settle.ts";
import { chooseOffer } from "../sdk/index.ts";
import { GasTracker } from "../sdk/buyer-settle.ts";
import { BuyerSettleFacilitator } from "../server/src/buyer-settle.ts";
import { settlementModesFromEnv, type ServerConfig } from "../server/src/config.ts";
import { mountCasperLive } from "../server/src/casper-live.ts";
import { StreamingMeter } from "../server/src/meter.ts";
import { MAINNET, TESTNET } from "../shared/networks.ts";
import { WCSPR_MAINNET, WCSPR_TESTNET, tokenProfile } from "../shared/tokens.ts";
import { loadConfig } from "../server/src/config.ts";
import type { Session, SettlementEvent, StreamSpec } from "../shared/types.ts";

/** A real testnet settlement (tx 1f389c8a..., block 9,775,850): Pico's buyer paying Helios Feeds. */
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/transfer-with-authorization.json", import.meta.url), "utf8"));
const TEST_PKG = "658bb84ba4aa82ffc98a55e0f8c447103dd9d4a28fb32fca3363aa0e1300017e";
const HELIOS = "0044f9e67c672341bcbcf5f444aa1541072d442526f644196d73eac124c737ad67";
const EXPECT: SettlementExpectation = {
  asset: TEST_PKG,
  payTo: HELIOS,
  amount: "3303500",
  nonce: "81ed2782c8b80fcf55bd6a6cecc0616aa929a388dc3489aec1e6f66ca6225896",
  chainName: "casper-test",
};
const TX = "1f389c8af74fb5260b402845f1d9d06e6689513e006c4b39ab1bc01f71919be3";

const fixture = () => structuredClone(FIXTURE);

/** A throwaway buyer key, standing in for the account that paid. */
const BUYER = casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519);
const BUYER_ADDR = "00" + BUYER.publicKey.accountHash().toHex();
const OTHER = casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const claim = (key: any, network: string, nonce: string, hash: string) => ({
  publicKey: key.publicKey.toHex(),
  claimSignature: hex(key.signAndAddAlgorithmBytes(claimMessage(network, nonce, hash))),
});
/** The chain read, faked: the fixture transfer, as if BUYER had sent it. */
const paidByBuyer = (expect: SettlementExpectation): SettlementCheck => {
  const r = checkSettlement(FIXTURE, expect);
  return r.ok ? { ...r, payer: BUYER_ADDR } : r;
};
const setArg = (tx: any, name: string, patch: Record<string, unknown>) => {
  const entry = tx.transaction.Version1.payload.fields.args.Named.find(([n]: [string]) => n === name);
  Object.assign(entry[1], patch);
  return tx;
};

describe("the server accepts a buyer's transaction only if it is exactly the payment asked for", () => {
  test("a real settled transfer matches its expectation", () => {
    const r = checkSettlement(fixture(), EXPECT);
    assert.ok(r.ok, !r.ok ? r.reason : "");
    if (!r.ok) return;
    assert.equal(r.payer, "0074f57790338ce156e5b346bd71d5914fdb7a6150bc73ec44a28090d29dc93c5a");
    assert.equal(r.gasMotes, "3273168227"); // 5 CSPR charged, 1.73 refunded
    assert.equal(r.blockHeight, 9775850);
  });

  const refusals: [string, (tx: any) => any, SettlementExpectation, RegExp][] = [
    ["another payee", (t) => t, { ...EXPECT, payTo: "00b76372880f98f0ddaf31257e32fb5b1b787a7bd9d20642dfac63b32ff7367a12" }, /different account/],
    ["a different amount", (t) => t, { ...EXPECT, amount: "3303501" }, /costs 3303501/],
    ["another tick's nonce", (t) => t, { ...EXPECT, nonce: "00".repeat(32) }, /nonce/],
    ["another token", (t) => t, { ...EXPECT, asset: "df101ac1be4fd5f390ce02fa4b43f610818d08d96f3183e182e92d325bd85950" }, /token's contract/],
    ["another chain", (t) => t, { ...EXPECT, chainName: "casper" }, /casper-test, expected casper/],
    ["another entry point", (t) => ((t.transaction.Version1.payload.fields.entry_point = { Custom: "transfer" }), t), EXPECT, /does not call/],
    ["a tampered amount argument", (t) => setArg(t, "amount", { parsed: "999" }), EXPECT, /moves 999/],
    ["a reverted transaction", (t) => ((t.execution_info.execution_result.Version2.error_message = "User error: 37003"), t), EXPECT, /failed on chain/],
    ["a legacy deploy", () => ({ transaction: { Deploy: {} } }), EXPECT, /Version1/],
  ];
  for (const [what, mutate, expect, reason] of refusals) {
    test(`refuses ${what}`, () => {
      const r = checkSettlement(mutate(fixture()), expect);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.pending, false);
      assert.match(r.reason, reason);
    });
  }

  test("a transaction not executed yet is pending, not refused", () => {
    const t = fixture();
    t.execution_info = null;
    const r = checkSettlement(t, EXPECT);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.pending, true);
  });
});

describe("one transfer pays one tick", () => {
  const req = {
    scheme: SCHEME_BUYER_SETTLE,
    network: TESTNET,
    asset: TEST_PKG,
    amount: EXPECT.amount,
    payTo: HELIOS,
    maxTimeoutSeconds: 180,
    extra: { name: "Casper X402 Token", version: "1", nonce: EXPECT.nonce },
  };
  const payload = (hash = TX, key: any = BUYER) => ({ x402Version: 2, accepted: req, payload: { transactionHash: hash, ...claim(key, TESTNET, EXPECT.nonce, hash) } }) as any;
  let reads = 0;
  const facilitator = (extra: Partial<ConstructorParameters<typeof BuyerSettleFacilitator>[0]> = {}) =>
    new BuyerSettleFacilitator({
      rpcByNetwork: { [TESTNET]: "http://unused" },
      confirm: async (_rpc, _hash, expect) => {
        reads++;
        return paidByBuyer(expect);
      },
      ...extra,
    });

  test("verify then settle a real transfer, reading the chain once", async () => {
    const f = facilitator();
    reads = 0;
    const v = await f.verify(payload(), req as any);
    assert.equal(v.isValid, true);
    assert.equal(v.payer, BUYER_ADDR);
    const s = await f.settle(payload(), req as any);
    assert.equal(s.success, true);
    assert.equal(s.transaction, TX);
    // settle reused verify's check: a flaky node between the two cannot halt a paid session.
    assert.equal(reads, 1);
  });

  test("someone who copies the hash off the chain cannot claim it", async () => {
    const f = facilitator();
    // Signed by a different key: refused, whatever the chain says.
    const stolen = await f.verify(payload(TX, OTHER), req as any);
    assert.equal(stolen.isValid, false);
    assert.match(String(stolen.invalidMessage), /different account/);
    // No claim at all: refused before any chain read.
    reads = 0;
    const bare = await f.verify({ ...payload(), payload: { transactionHash: TX } }, req as any);
    assert.equal(bare.isValid, false);
    assert.equal(reads, 0);
    // A claim for another tick's nonce does not carry over.
    const otherTick = { ...payload(), payload: { transactionHash: TX, ...claim(BUYER, TESTNET, "11".repeat(32), TX) } };
    assert.equal((await f.verify(otherTick, req as any)).isValid, false);
  });

  test("past its limit of chain reads at once, it refuses at once instead of queueing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = facilitator({
      maxInFlight: 1,
      confirm: async (_rpc, _hash, expect) => {
        await gate;
        return paidByBuyer(expect);
      },
    });
    const first = f.verify(payload(), req as any);
    const second = await f.verify(payload("ab".repeat(32)), req as any);
    assert.equal(second.isValid, false);
    assert.match(String(second.invalidMessage), /busy/);
    release();
    assert.equal((await first).isValid, true);
  });

  test("the same transaction never settles twice, even when two requests race", async () => {
    const f = facilitator();
    const [a, b] = await Promise.all([f.settle(payload(), req as any), f.settle(payload(), req as any)]);
    assert.deepEqual([a.success, b.success].sort(), [false, true]);
    assert.equal((await f.verify(payload(), req as any)).isValid, false);
  });

  test("refuses a missing or malformed hash, another scheme, and a network it does not serve", async () => {
    const f = facilitator();
    assert.equal((await f.verify(payload("xyz"), req as any)).isValid, false);
    assert.equal((await f.verify({ ...payload(), accepted: { ...req, scheme: "exact" } }, req as any)).isValid, false);
    const main = { ...req, network: MAINNET };
    assert.equal((await f.verify({ ...payload(), accepted: main }, main as any)).isValid, false);
  });

  test("advertises buyer-settle only on its networks, with no signers (it never signs)", async () => {
    const s = await facilitator().getSupported();
    assert.deepEqual(s.kinds, [{ x402Version: 2, scheme: SCHEME_BUYER_SETTLE, network: TESTNET }]);
    assert.deepEqual(s.signers, {});
  });
});

describe("the operator never pays gas on mainnet unless told to", () => {
  test("by default mainnet is buyer-settle only; testnet offers both", () => {
    assert.deepEqual(settlementModesFromEnv([MAINNET, TESTNET], {}), { sponsored: [TESTNET], buyerSettle: [MAINNET, TESTNET] });
  });
  test("SPONSORED_NETWORKS can name mainnet explicitly", () => {
    assert.deepEqual(settlementModesFromEnv([MAINNET, TESTNET], { SPONSORED_NETWORKS: MAINNET }).sponsored, [MAINNET]);
  });
  test("an empty list switches a mode off, and unserved networks are ignored", () => {
    assert.deepEqual(settlementModesFromEnv([TESTNET], { BUYER_SETTLE_NETWORKS: "", SPONSORED_NETWORKS: `${MAINNET},${TESTNET}` }), {
      sponsored: [TESTNET],
      buyerSettle: [],
    });
  });
});

describe("a full paid tick over HTTP, buyer paying its own gas", () => {
  const SPEC: StreamSpec = { id: "eth-usd", title: "ETH/USD", description: "", ratePerSecond: "800000", asset: "X402", provider: "Helios Feeds", payTo: HELIOS };
  const store = () => {
    const sessions = new Map<string, Session>();
    const events: SettlementEvent[] = [];
    return { streams: new Map([[SPEC.id, SPEC]]), getSession: (id: string) => sessions.get(id), putSession: (s: Session) => void sessions.set(s.id, s), addEvent: (e: SettlementEvent) => void events.push(e), events };
  };
  const cfg = {
    mode: "live",
    payTo: HELIOS,
    assetName: "Casper X402 Token",
    networks: [{ id: TESTNET, assetPackage: TEST_PKG, explorer: "https://testnet.cspr.live" }],
    sponsoredNetworks: [],
    buyerSettleNetworks: [TESTNET],
    facilitatorUrl: "http://unused",
    facilitatorApiKey: "",
  } as unknown as ServerConfig;

  test("402 offers buyer-settle with a fresh nonce; the matching transfer buys exactly one tick", async () => {
    const s = store();
    const meter = new StreamingMeter(s, { payTo: HELIOS, maxTickSeconds: 10 });
    const seen: SettlementExpectation[] = [];
    // The chain read is replaced: it answers "this transfer executed exactly as expected".
    const confirm = async (_rpc: string, _hash: string, expect: SettlementExpectation) => {
      seen.push(expect);
      return { ok: true as const, payer: BUYER_ADDR, initiator: BUYER.publicKey.toHex(), gasMotes: "3273168227", blockHeight: 1 };
    };
    const app = express();
    app.use(express.json());
    mountCasperLive(app, cfg, meter, { confirm });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const session = meter.openSession("eth-usd", BUYER_ADDR);
      const url = `${base}/tick?session=${session.id}`;

      const challenge = await fetch(url, { method: "POST" });
      assert.equal(challenge.status, 402);
      const required = decodePaymentRequiredHeader(challenge.headers.get("payment-required")!);
      assert.deepEqual(required.accepts.map((a) => a.scheme), [SCHEME_BUYER_SETTLE]);
      const offer = required.accepts[0];
      const nonce = String(offer.extra?.nonce);
      assert.match(nonce, /^[0-9a-f]{64}$/);
      assert.equal(offer.maxTimeoutSeconds, 180);

      const pay = (accepted: typeof offer) =>
        fetch(url, {
          method: "POST",
          headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transactionHash: TX, ...claim(BUYER, TESTNET, nonce, TX) } } as any) },
        });

      const paid = await pay(offer);
      assert.equal(paid.status, 200, await paid.clone().text());
      const body = (await paid.json()) as { session: Session };
      assert.equal(body.session.ticks, 1);
      assert.equal(s.events.length, 1);
      assert.equal(s.events[0].txHash, TX);
      assert.equal(s.events[0].explorerUrl, `https://testnet.cspr.live/transaction/${TX}`);
      // The server asked the chain for exactly this tick's transfer.
      assert.deepEqual(seen[0], { asset: TEST_PKG, payTo: HELIOS, amount: offer.amount, nonce, chainName: "casper-test", amountArg: "amount" });

      // Replaying the same payment cannot buy a second tick: the next quote has a new nonce.
      const replay = await pay(offer);
      assert.equal(replay.status, 402);
      assert.equal(s.events.length, 1);
      assert.equal(meter.streamOf(session.id)?.id, "eth-usd");
    } finally {
      server.close();
    }
  });
});

describe("the agent never pays gas it was not asked to", () => {
  const offers = [
    { network: MAINNET, scheme: SCHEME_BUYER_SETTLE },
    { network: TESTNET, scheme: "exact" },
    { network: TESTNET, scheme: SCHEME_BUYER_SETTLE },
  ];
  test("no network named: a server-paid offer anywhere beats paying mainnet gas", () => {
    assert.deepEqual(chooseOffer(2, offers), { network: TESTNET, scheme: "exact" });
  });
  test("a named network: server-paid there if offered, else the buyer pays there", () => {
    assert.deepEqual(chooseOffer(2, offers, TESTNET), { network: TESTNET, scheme: "exact" });
    assert.deepEqual(chooseOffer(2, offers, MAINNET), { network: MAINNET, scheme: SCHEME_BUYER_SETTLE });
  });
  test("only buyer-settle registered (payGas true): pays its own gas, on the network asked", () => {
    const own = offers.filter((o) => o.scheme === SCHEME_BUYER_SETTLE);
    assert.deepEqual(chooseOffer(2, own, TESTNET), { network: TESTNET, scheme: SCHEME_BUYER_SETTLE });
  });
});

describe("gas accounting counts every transfer the agent sent", () => {
  test("refused and failed transfers count; each transfer counts once", () => {
    const g = new GasTracker();
    g.begin();
    g.noteSubmitted("a");
    g.noteGas("a", 3_000_000_000n); // accepted
    g.noteGas("b", 3_200_000_000n); // refused by the server, or reverted: still spent
    g.noteGas("a", 3_000_000_000n); // seen again on a retry: not double-counted
    assert.equal(g.total, 6_200_000_000n);
    assert.deepEqual(g.submitted, ["a"]);
    assert.equal(g.take("a"), 3_000_000_000n);
    assert.equal(g.take("a"), 0n);
    g.begin();
    assert.deepEqual(g.submitted, []);
  });
});

describe("mainnet customers pay in WCSPR, a token they can buy", () => {
  /** A real testnet WCSPR payment (tx f4587b91..., block 9,812,657): Sluice's buyer paying Pico. */
  const WFIX = JSON.parse(readFileSync(new URL("./fixtures/wcspr-transfer-with-authorization.json", import.meta.url), "utf8"));
  const WEXPECT: SettlementExpectation = {
    asset: WCSPR_TESTNET,
    payTo: "00e01c092d8b3ed9b91b68a5ec563834a7fe55c64dff77a21f5ed3f3e4bd40e1c7",
    amount: "5417000715",
    nonce: "0d0aedcd8dec93ef56e6b5af029bdfd481e5a0c3901298c366be4b2488f4c584",
    chainName: "casper-test",
    amountArg: "value",
  };

  test("WCSPR is recognised on both networks, with its own name and amount argument", () => {
    for (const pkg of [WCSPR_MAINNET, `hash-${WCSPR_TESTNET}`]) {
      assert.deepEqual(tokenProfile(pkg, "Casper X402 Token"), { name: "Wrapped CSPR", symbol: "WCSPR", version: "1", decimals: 9, amountArg: "value" });
    }
    assert.equal(tokenProfile(TEST_PKG, "Casper X402 Token").amountArg, "amount");
  });

  test("a real WCSPR transfer matches when read by its `value` argument, and only then", () => {
    const r = checkSettlement(WFIX, WEXPECT);
    assert.ok(r.ok, !r.ok ? r.reason : "");
    if (r.ok) assert.equal(r.payer, "0078a9a1842a290e7edfac536ad9570d3a29ad5909761973727483263aacdff80c");
    const wrongArg = checkSettlement(WFIX, { ...WEXPECT, amountArg: "amount" });
    assert.equal(wrongArg.ok, false);
  });

  test("a WCSPR network is never sponsored, even if SPONSORED_NETWORKS names it", () => {
    const set = { MODE: "live", NETWORKS: TESTNET, ASSET_PACKAGE_TESTNET: WCSPR_TESTNET, SPONSORED_NETWORKS: TESTNET, BUYER_SETTLE_NETWORKS: TESTNET };
    const before = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, set);
      const cfg = loadConfig();
      assert.deepEqual(cfg.sponsoredNetworks, []);
      assert.deepEqual(cfg.buyerSettleNetworks, [TESTNET]);
    } finally {
      // Put each key back on the real env object (never replace process.env itself).
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("the 402 for a WCSPR network names WCSPR and its `value` argument; the feed records WCSPR", async () => {
    const sessions = new Map<string, Session>();
    const events: SettlementEvent[] = [];
    const SPEC: StreamSpec = { id: "eth-usd", title: "ETH/USD", description: "", ratePerSecond: "800000", asset: "X402", provider: "Helios Feeds", payTo: HELIOS };
    const st = { streams: new Map([[SPEC.id, SPEC]]), getSession: (id: string) => sessions.get(id), putSession: (x: Session) => void sessions.set(x.id, x), addEvent: (e: SettlementEvent) => void events.push(e) };
    const meter = new StreamingMeter(st, { payTo: HELIOS, maxTickSeconds: 10 });
    const cfg = {
      mode: "live",
      payTo: HELIOS,
      assetName: "Casper X402 Token",
      networks: [{ id: TESTNET, assetPackage: WCSPR_TESTNET, explorer: "https://testnet.cspr.live" }],
      sponsoredNetworks: [],
      buyerSettleNetworks: [TESTNET],
      facilitatorUrl: "http://unused",
      facilitatorApiKey: "",
    } as unknown as ServerConfig;
    const seen: SettlementExpectation[] = [];
    const app = express();
    app.use(express.json());
    mountCasperLive(app, cfg, meter, {
      confirm: async (_rpc, _hash, expect) => {
        seen.push(expect);
        return { ok: true as const, payer: BUYER_ADDR, initiator: BUYER.publicKey.toHex(), gasMotes: "1", blockHeight: 1 };
      },
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const session = meter.openSession("eth-usd", BUYER_ADDR);
      const url = `${base}/tick?session=${session.id}`;
      const offer = decodePaymentRequiredHeader((await fetch(url, { method: "POST" })).headers.get("payment-required")!).accepts[0];
      assert.equal(offer.asset, WCSPR_TESTNET);
      assert.equal(offer.extra?.name, "Wrapped CSPR");
      assert.equal(offer.extra?.symbol, "WCSPR");
      assert.equal(offer.extra?.amountArg, "value");
      const nonce = String(offer.extra?.nonce);
      const paid = await fetch(url, {
        method: "POST",
        headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({ x402Version: 2, accepted: offer, payload: { transactionHash: TX, ...claim(BUYER, TESTNET, nonce, TX) } } as any) },
      });
      assert.equal(paid.status, 200);
      assert.equal(seen[0].amountArg, "value");
      assert.equal(events[0].asset, "WCSPR");
    } finally {
      server.close();
    }
  });
});

describe("review fixes", () => {
  test("a pre-2.0 Version1 execution result is read correctly: a Failure is a failure", () => {
    assert.deepEqual(readExecution({ Version1: { Failure: { cost: "100", error_message: "User error: 60001" } } }), { gasMotes: 100n, error: "User error: 60001" });
    assert.deepEqual(readExecution({ Version1: { Success: { cost: "70" } } }), { gasMotes: 70n });
    assert.deepEqual(readExecution({ Version2: { cost: "90", refund: "10", error_message: null } }), { gasMotes: 80n, error: undefined });
    assert.equal(readExecution(undefined), null);
    const failed = checkSettlement({ ...FIXTURE, execution_info: { ...FIXTURE.execution_info, execution_result: { Version1: { Failure: { cost: "5", error_message: "boom" } } } } }, EXPECT);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.pending, false);
  });

  test("totals never add amounts paid in different tokens", () => {
    const store = new Store(new Map(), join(tmpdir(), `sluice-totals-${process.pid}.json`));
    const ev = (asset: string, amount: string) => ({ id: asset + amount, sessionId: "s", streamId: "x", agent: "a", payTo: "p", amount, asset, seconds: 1, tx: "t", network: TESTNET, at: 0 }) as unknown as SettlementEvent;
    store.addEvent(ev("X402", "300"));
    store.addEvent(ev("WCSPR", "5"));
    const t = store.totals(TESTNET);
    assert.equal(t.settlements, 2);
    assert.equal(t.paidByAsset.get("X402"), 300n);
    assert.equal(t.paidByAsset.get("WCSPR"), 5n);
  });
});
