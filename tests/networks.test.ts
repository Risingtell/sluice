/**
 * Mainnet is Sluice's default path and testnet stays available. These tests pin how the server,
 * the facilitator and every client choose a network, and that the two are never added together.
 *
 *   npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networksFromEnv } from "../server/src/config.ts";
import { Store } from "../server/src/store.ts";
import { facilitatorOptionsFromEnv } from "../facilitator/src/router.ts";
import { MAINNET, TESTNET, networkSelector, parseNetworks, rpcOverride } from "../shared/networks.ts";
import type { SettlementEvent, StreamSpec } from "../shared/types.ts";

const MAIN_PKG = "df101ac1be4fd5f390ce02fa4b43f610818d08d96f3183e182e92d325bd85950";
const TEST_PKG = "658bb84ba4aa82ffc98a55e0f8c447103dd9d4a28fb32fca3363aa0e1300017e";

describe("mainnet is the default network and testnet stays available", () => {
  test("NETWORKS lists mainnet first, each network with its own token", () => {
    const n = networksFromEnv({ NETWORKS: `${MAINNET},${TESTNET}`, ASSET_PACKAGE_MAINNET: `hash-${MAIN_PKG}`, ASSET_PACKAGE_TESTNET: TEST_PKG });
    assert.deepEqual(
      n.map((x) => [x.id, x.assetPackage, x.explorer]),
      [
        [MAINNET, MAIN_PKG, "https://cspr.live"],
        [TESTNET, TEST_PKG, "https://testnet.cspr.live"],
      ],
    );
  });

  test("an existing single-network .env keeps working", () => {
    assert.deepEqual(networksFromEnv({ CAIP2_CHAIN_ID: TESTNET, ASSET_PACKAGE: TEST_PKG }), [
      { id: TESTNET, assetPackage: TEST_PKG, explorer: "https://testnet.cspr.live" },
    ]);
  });

  test("a network without its own token is left out, never given the other network's token", () => {
    const n = networksFromEnv({ NETWORKS: `${MAINNET},${TESTNET}`, ASSET_PACKAGE: TEST_PKG, ASSET_PACKAGE_TESTNET: TEST_PKG });
    assert.deepEqual(n, [{ id: TESTNET, assetPackage: TEST_PKG, explorer: "https://testnet.cspr.live" }]);
  });

  test("a repeated network is dropped and the order is kept", () => {
    assert.deepEqual(parseNetworks(` ${TESTNET}, ${MAINNET},${TESTNET}`), [TESTNET, MAINNET]);
  });
});

describe("the facilitator serves every network the server sells on", () => {
  test("it follows NETWORKS, allows both tokens, and takes an RPC override per network", () => {
    const o = facilitatorOptionsFromEnv({
      NETWORKS: `${MAINNET},${TESTNET}`,
      ASSET_PACKAGE_MAINNET: MAIN_PKG,
      ASSET_PACKAGE_TESTNET: TEST_PKG,
      FACILITATOR_RPC_URL_MAINNET: "https://rpc.example/main",
      FACILITATOR_RPC_URL: "https://ignored.example",
    });
    assert.deepEqual(o.networks, [MAINNET, TESTNET]);
    assert.ok(o.allowedAssets.has(MAIN_PKG) && o.allowedAssets.has(TEST_PKG));
    assert.equal(o.rpcUrls?.[MAINNET], "https://rpc.example/main");
    // FACILITATOR_RPC_URL names one node, so with two networks it applies to neither.
    assert.equal(o.rpcUrls?.[TESTNET], undefined);
  });

  test("the faucet and the facilitator resolve private RPC nodes by the same rule", () => {
    const env = { FACILITATOR_RPC_URL_TESTNET: "https://rpc.example/test", FACILITATOR_RPC_URL: "https://one.example" };
    assert.equal(rpcOverride(TESTNET, env, 2), "https://rpc.example/test");
    assert.equal(rpcOverride(MAINNET, env, 2), undefined);
    assert.equal(rpcOverride(MAINNET, env, 1), "https://one.example");
  });

  test("FACILITATOR_RPC_URL still applies when there is one network", () => {
    const o = facilitatorOptionsFromEnv({ CAIP2_CHAIN_ID: TESTNET, ASSET_PACKAGE: TEST_PKG, FACILITATOR_RPC_URL: "https://rpc.example/test" });
    assert.deepEqual(o.networks, [TESTNET]);
    assert.equal(o.rpcUrls?.[TESTNET], "https://rpc.example/test");
  });
});

describe("a buyer pays on the network it chose", () => {
  const offers = [{ network: MAINNET }, { network: TESTNET }];

  test("with no preference it pays with the server's first Casper offer, which is mainnet", () => {
    assert.equal(networkSelector()(2, offers).network, MAINNET);
  });

  test("asking for testnet pays on testnet although mainnet is listed first", () => {
    assert.equal(networkSelector(TESTNET)(2, offers).network, TESTNET);
  });

  test("asking for a network the server does not offer refuses rather than paying elsewhere", () => {
    assert.throws(() => networkSelector(TESTNET)(2, [{ network: MAINNET }]), /does not accept payment on casper:casper-test/);
  });
});

describe("mainnet and testnet are never added together", () => {
  test("totals and rows are per network, and rows saved before networks were recorded are testnet", () => {
    const store = new Store(new Map<string, StreamSpec>(), join(tmpdir(), `sluice-networks-${process.pid}.json`));
    const ev = (network: string | undefined, amount: string): SettlementEvent =>
      ({ sessionId: "s", streamId: "btc-usd", agent: "a", payTo: "p", amount, asset: "X402", seconds: 1, network, txHash: "t", explorerUrl: "", settledAt: 1 }) as SettlementEvent;
    store.addEvent(ev(TESTNET, "5"));
    store.addEvent(ev(undefined, "7"));
    store.addEvent(ev(MAINNET, "11"));

    assert.equal(store.totals(TESTNET).totalPaid, 12n);
    assert.equal(store.totals(TESTNET).settlements, 2);
    assert.equal(store.totals(MAINNET).totalPaid, 11n);
    assert.equal(store.totals(MAINNET).settlements, 1);
    assert.deepEqual(store.recentEvents(10, MAINNET).map((e) => e.amount), ["11"]);
    assert.equal(store.settlementsByNetwork().get(TESTNET), 2);
  });
});
