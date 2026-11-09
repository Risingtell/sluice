/**
 * Every stream Sluice sells carries real data. These tests pin the catalogue (the GPU simulation is
 * retired, but its history keeps its provider), how the Casper block feed reads a real node answer
 * without ever inventing a block, and when the block-watcher agent closes its own gate.
 *
 *   npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETIRED_STREAMS, STREAMS } from "../server/src/config.ts";
import { Store } from "../server/src/store.ts";
import { StreamingMeter, MeterError } from "../server/src/meter.ts";
import { CASPER_FRESH_MS, casperChunk, parseCasperBlock } from "../server/src/casper-block.ts";
import { blockWatcher, policyForStream } from "../agent/src/policy.ts";
import type { SettlementEvent } from "../shared/types.ts";

describe("every stream for sale carries real data", () => {
  test("the catalogue is BTC/USD, ETH/USD and Casper mainnet blocks, and the GPU simulation is retired", () => {
    assert.deepEqual(STREAMS.map((s) => s.id), ["btc-usd", "eth-usd", "casper-blocks"]);
    assert.ok(STREAMS.every((s) => !s.retired));
    assert.deepEqual(RETIRED_STREAMS.map((s) => [s.id, s.provider, s.retired]), [["gpu-telemetry", "NimbusGPU", true]]);
  });

  test("the Casper block feed is a second product of Helios Feeds, paid into the same treasury", () => {
    const eth = STREAMS.find((s) => s.id === "eth-usd")!;
    const casper = STREAMS.find((s) => s.id === "casper-blocks")!;
    assert.equal(casper.provider, "Helios Feeds");
    assert.equal(casper.payTo, eth.payTo);
  });

  test("a retired stream takes no new sessions, but its settlements keep their provider in the history", () => {
    const streams = new Map([...STREAMS, ...RETIRED_STREAMS].map((s) => [s.id, s]));
    const store = new Store(streams, join(tmpdir(), `sluice-streams-${process.pid}.json`));
    const meter = new StreamingMeter(store, { payTo: "x", maxTickSeconds: 10 });
    assert.throws(() => meter.openSession("gpu-telemetry", "agent-1"), (e: unknown) => e instanceof MeterError && e.status === 410);
    assert.equal(meter.openSession("casper-blocks", "agent-1").streamId, "casper-blocks");

    const ev = (streamId: string, payTo: string) =>
      ({ sessionId: "s", streamId, agent: "a", payTo, amount: "1", asset: "X402", seconds: 1, network: "casper:casper-test", txHash: streamId, explorerUrl: "", settledAt: 1 }) as SettlementEvent;
    store.addEvent(ev("gpu-telemetry", "00fc58ce"));
    store.addEvent(ev("eth-usd", "0044f9e6"));
    store.addEvent(ev("casper-blocks", "0044f9e6"));
    // NimbusGPU from the history, plus Helios Feeds once for its two streams.
    assert.equal(store.totals().uniqueProviders, 2);
  });

  test("a session left open on a retired stream is never billed again", () => {
    const streams = new Map([...STREAMS, ...RETIRED_STREAMS].map((s) => [s.id, s]));
    const store = new Store(streams, join(tmpdir(), `sluice-streams-open-${process.pid}.json`));
    const meter = new StreamingMeter(store, { payTo: "x", maxTickSeconds: 10 });
    // As if restored from a snapshot written before the stream was retired.
    const s = meter.openSession("casper-blocks", "agent-2");
    store.putSession({ ...s, streamId: "gpu-telemetry" });
    assert.throws(() => meter.quoteTick(s.id), (e: unknown) => e instanceof MeterError && e.status === 410);
  });
});

describe("a paid tick reports the session as it reads once the tick settles", () => {
  test("the live response shows the same ticks and total that settlement then records", () => {
    const store = new Store(new Map(STREAMS.map((s) => [s.id, s])), join(tmpdir(), `sluice-streams-after-${process.pid}.json`));
    const meter = new StreamingMeter(store, { payTo: "x", maxTickSeconds: 10 });
    const s = meter.openSession("casper-blocks", "agent-3");
    for (let i = 0; i < 2; i++) {
      const quote = meter.quoteTick(s.id);
      const shown = meter.sessionAfter(quote);
      const { session: recorded } = meter.commitTick(quote, { txHash: `t${i}`, network: "casper:casper-test", explorerUrl: "" });
      assert.deepEqual(
        [shown.ticks, shown.totalPaid, shown.settledMs, shown.lastSettledAt],
        [recorded.ticks, recorded.totalPaid, recorded.settledMs, recorded.lastSettledAt],
      );
      assert.equal(shown.ticks, i + 1);
    }
  });
});

describe("the Casper block feed reads real blocks and never invents one", () => {
  const v2 = {
    block_with_signatures: {
      block: {
        Version2: {
          header: { height: 9530031, era_id: 24510, timestamp: "2026-11-09T06:41:00.393Z", proposer: "01a4b5c6d7e8f90011223344", current_gas_price: 1 },
          body: { transactions: { "0": ["a", "b"], "1": [], "3": ["c"] }, rewarded_signatures: [] },
        },
      },
    },
  };

  test("a Casper 2.0 block gives its height, era, time, transaction count and proposer", () => {
    assert.deepEqual(parseCasperBlock(v2, 1000), {
      height: 9530031,
      era: 24510,
      timestamp: "2026-11-09T06:41:00.393Z",
      transactions: 3,
      proposer: "01a4b5c6d7e8f90011223344",
      gasPrice: 1,
      fetchedAt: 1000,
    });
  });

  test("an older Version1 block counts its deploys and finds its proposer in the body", () => {
    const v1 = { block_with_signatures: { block: { Version1: { header: { height: 5, era_id: 1, timestamp: "2024-01-01T00:00:00.000Z" }, body: { proposer: "01ff", deploy_hashes: ["d1", "d2"], transfer_hashes: [] } } } } };
    const b = parseCasperBlock(v1, 1)!;
    assert.equal(b.transactions, 2);
    assert.equal(b.proposer, "01ff");
  });

  test("a malformed answer is rejected instead of becoming a block", () => {
    assert.equal(parseCasperBlock(undefined, 1), undefined);
    assert.equal(parseCasperBlock({ block_with_signatures: { block: { Version2: { header: { height: "x", timestamp: "nope" } } } } }, 1), undefined);
  });

  test("a fresh reading is live; no reading, or an old one, is served as not live", () => {
    const b = parseCasperBlock(v2, Date.parse("2026-11-09T06:41:02.000Z"))!;
    const fresh: any = casperChunk(b, 1, Date.parse("2026-11-09T06:41:05.000Z"));
    assert.equal(fresh.live, true);
    assert.equal(fresh.height, 9530031);
    assert.equal(fresh.secondsSinceBlock, 5);
    assert.equal(fresh.source, "casper-node");
    assert.equal((casperChunk(b, 2, b.fetchedAt + CASPER_FRESH_MS + 1) as any).live, false);
    const none: any = casperChunk(undefined, 1, Date.now());
    assert.equal(none.live, false);
    assert.equal("height" in none, false);
  });
});

describe("the block-watcher agent closes its own gate", () => {
  const ctx = (tick: number) => ({ tick, spentMotes: 0n, nextTickMotes: 1n, budgetMotes: 1_000_000n });
  const live = (height: number, extra: Record<string, unknown> = {}) => ({ live: true, height, secondsSinceBlock: 3, ...extra });

  test("it stops once it has seen 2 new mainnet blocks, naming the heights", () => {
    const p = blockWatcher();
    assert.equal(p.decide(live(100), ctx(1)).keepStreaming, true);
    assert.equal(p.decide(live(101), ctx(2)).keepStreaming, true);
    const d = p.decide(live(102), ctx(3));
    assert.equal(d.keepStreaming, false);
    assert.match(d.reason, /saw 2 new mainnet blocks \(100 to 102\)/);
  });

  test("it stops when the network looks stalled", () => {
    const d = blockWatcher().decide(live(100, { secondsSinceBlock: 90 }), ctx(1));
    assert.equal(d.keepStreaming, false);
    assert.match(d.reason, /stalled/);
  });

  test("stale readings never count as blocks, and 3 in a row end the stream", () => {
    const p = blockWatcher();
    assert.equal(p.decide({ live: false, height: 100 }, ctx(1)).keepStreaming, true);
    assert.equal(p.decide({ live: false, height: 100 }, ctx(2)).keepStreaming, true);
    const d = p.decide({ live: false }, ctx(3));
    assert.equal(d.keepStreaming, false);
    assert.match(d.reason, /not live for 3 ticks/);
  });

  test("a fresh reading resets the stale count", () => {
    const p = blockWatcher();
    p.decide({ live: false }, ctx(1));
    p.decide({ live: false }, ctx(2));
    assert.equal(p.decide(live(100), ctx(3)).keepStreaming, true);
    assert.equal(p.decide({ live: false }, ctx(4)).keepStreaming, true);
  });

  test("it never authorizes a tick past its budget", () => {
    const d = blockWatcher().decide(live(100), { tick: 1, spentMotes: 900n, nextTickMotes: 200n, budgetMotes: 1000n });
    assert.equal(d.keepStreaming, false);
    assert.match(d.reason, /budget/);
  });

  test("the Casper block stream gets the block-watcher, and price streams keep the trend-hunter", () => {
    assert.equal(policyForStream("casper-blocks", 0.05).policy.name, "block-watcher");
    assert.equal(policyForStream("eth-usd", 0.05).policy.name, "trend-hunter");
  });
});
