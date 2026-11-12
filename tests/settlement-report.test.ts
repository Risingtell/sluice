/**
 * What an outside agent (Pico's buyer, 9 Nov 2026) reported back: settlements are Casper 2.0
 * Version1 transactions, so the feed names them transactionHash and links /transaction/, and a live
 * tick's real resolution is its settlement time, which the SDK now measures.
 *
 *   npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/src/store.ts";
import { MAINNET, TESTNET, explorerTxUrl } from "../shared/networks.ts";
import { timing } from "../sdk/index.ts";
import type { SettlementEvent, StreamSpec } from "../shared/types.ts";

const H = "1f389c8af74fb5260b402845f1d9d06e6689513e006c4b39ab1bc01f71919be3";

describe("settlement links and names", () => {
  test("explorer links use cspr.live's /transaction/ route on each network", () => {
    assert.equal(explorerTxUrl(TESTNET, H), `https://testnet.cspr.live/transaction/${H}`);
    assert.equal(explorerTxUrl(MAINNET, H), `https://cspr.live/transaction/${H}`);
    assert.equal(explorerTxUrl(TESTNET, ""), "");
  });

  test("the feed returns transactionHash for stored rows that only have txHash", () => {
    const store = new Store(new Map<string, StreamSpec>(), join(tmpdir(), `sluice-report-${process.pid}.json`));
    store.addEvent({ sessionId: "s", streamId: "btc-usd", agent: "a", payTo: "p", amount: "1", asset: "X402", seconds: 1, network: TESTNET, txHash: H, explorerUrl: `https://testnet.cspr.live/deploy/${H}`, settledAt: 1 } as SettlementEvent);
    const [row] = store.recentEvents(1);
    assert.equal(row.transactionHash, H);
    assert.equal(row.txHash, H);
    // A row stored before the switch still links the legacy route; the feed serves /transaction/.
    assert.equal(row.explorerUrl, `https://testnet.cspr.live/transaction/${H}`);
  });
});

describe("settlement timing", () => {
  test("min / median / max, even and odd counts", () => {
    assert.deepEqual(timing([7000, 4000, 11100]), { minMs: 4000, medianMs: 7000, maxMs: 11100 });
    assert.deepEqual(timing([4000, 6000, 8000, 11000]), { minMs: 4000, medianMs: 7000, maxMs: 11000 });
    assert.equal(timing([]), null);
  });
});
