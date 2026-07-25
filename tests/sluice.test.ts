/**
 * Sluice test suite.
 *
 * These tests defend the project's public claims, so they are named after the claim rather than
 * after the function. Two of them assert against the REAL committed on-chain ledger snapshot in
 * data/onchain-actions.json, so a drift between what the chain shows and what the feed publishes
 * fails the build rather than shipping as an over-claim.
 *
 *   npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveSettlements, findUnbacked, type LedgerAction } from "../shared/verify-lib.ts";
import { StreamingMeter, MeterError } from "../server/src/meter.ts";
import { policyForStream } from "../agent/src/policy.ts";
import type { Session, SettlementEvent, StreamSpec } from "../shared/types.ts";

const AGENTS = new Set([
  "78e91a622946f671f80edcb1c7d67db1a35502161a0d38ca82c9bee9c189c80a",
  "3bf4cd516c13790c2053ca51ca0089aa80b1d157e9c47785d004990868b6ab84",
  "fe0d626c926c6b97c8d5c1ea03de7400750ad909b87f81b25b9fe573dcaac4bb",
  "1e692c446427ea26b7cf5f855464d77cb3086b96d26ee470992d1ae6c8ced8ec",
  "cc40818d04421510aaf1e2d7e51fefbc4c00dd83d16b6bde4f7c03456764659b",
]);

const ledger = (): LedgerAction[] => JSON.parse(readFileSync("data/onchain-actions.json", "utf8"));
const feed = () => JSON.parse(readFileSync("docs/proof.json", "utf8"));

describe("the published numbers are backed by the Casper ledger", () => {
  test("never_overclaims_more_settlements_than_the_chain_shows", () => {
    const chain = deriveSettlements(ledger(), AGENTS);
    const claimed = feed().totals.settlements as number;
    assert.ok(
      chain.count >= claimed,
      `feed claims ${claimed} settlements but the chain only shows ${chain.count}`,
    );
  });

  test("never_overclaims_more_value_than_the_chain_shows", () => {
    const chain = deriveSettlements(ledger(), AGENTS);
    const claimedPaid = BigInt(feed().totals.totalPaid);
    assert.ok(
      chain.total >= claimedPaid,
      `feed claims ${claimedPaid} paid but the chain only shows ${chain.total}`,
    );
  });

  test("every_published_settlement_is_backed_by_an_onchain_transfer", () => {
    const chain = deriveSettlements(ledger(), AGENTS);
    const rows = (feed().recent ?? []) as Array<{ txHash?: string }>;
    assert.ok(rows.length > 0, "proof feed published no settlement rows");
    const unbacked = findUnbacked(rows, chain.settledHashes);
    assert.deepEqual(
      unbacked.map((r) => r.txHash),
      [],
      "the feed publishes settlements the ledger does not show",
    );
  });

  test("unbacked_settlement_row_is_detected", () => {
    // A reverted deploy still returns a transaction hash, so a well-formed hash proves nothing.
    // This is the guard that catches a settlement recorded without landing on-chain.
    const chain = deriveSettlements(ledger(), AGENTS);
    const ghost = { txHash: "d34db33f".repeat(8) };
    assert.equal(findUnbacked([ghost], chain.settledHashes).length, 1);
  });

  test("mint_and_agent_funding_are_not_counted_as_settlements", () => {
    const agent = [...AGENTS][0];
    const other = [...AGENTS][1];
    const actions: LedgerAction[] = [
      { from_hash: "", to_hash: agent, amount: "1000", deploy_hash: "mint" }, // mint
      { from_hash: agent, to_hash: other, amount: "500", deploy_hash: "funding" }, // agent to agent
      { from_hash: agent, to_hash: "b76372", amount: "7", deploy_hash: "real" }, // a settlement
    ];
    const d = deriveSettlements(actions, AGENTS);
    assert.equal(d.count, 1);
    assert.equal(d.total, 7n);
    assert.ok(d.settledHashes.has("real"));
  });
});

/** Minimal in-memory store satisfying what StreamingMeter needs. */
function fakeStore(spec: StreamSpec) {
  const sessions = new Map<string, Session>();
  const events: SettlementEvent[] = [];
  return {
    streams: new Map([[spec.id, spec]]),
    getSession: (id: string) => sessions.get(id),
    putSession: (s: Session) => void sessions.set(s.id, s),
    addEvent: (e: SettlementEvent) => void events.push(e),
    events,
  };
}

const SPEC = {
  id: "btc-usd",
  title: "BTC/USD",
  provider: "Lumen Markets",
  ratePerSecond: "1000000",
  asset: "X402",
  payTo: "00b76372",
} as unknown as StreamSpec;

describe("the streaming meter bills only for time actually paid for", () => {
  test("quoting_a_tick_does_not_record_a_settlement", () => {
    const store = fakeStore(SPEC);
    const meter = new StreamingMeter(store, { payTo: "00b76372", maxTickSeconds: 10 });
    const s = meter.openSession("btc-usd", "agent-1");
    meter.quoteTick(s.id);
    meter.quoteTick(s.id);
    assert.equal(store.events.length, 0, "a quote must never record a settlement");
    assert.equal(store.getSession(s.id)!.ticks, 0);
    assert.equal(store.getSession(s.id)!.totalPaid, "0");
  });

  test("commits_a_tick_only_after_settlement", () => {
    const store = fakeStore(SPEC);
    const meter = new StreamingMeter(store, { payTo: "00b76372", maxTickSeconds: 10 });
    const s = meter.openSession("btc-usd", "agent-1");
    const quote = meter.quoteTick(s.id);
    meter.commitTick(quote, { txHash: "abc", explorerUrl: "", network: "casper:casper-test" });
    assert.equal(store.events.length, 1);
    assert.equal(store.getSession(s.id)!.ticks, 1);
    assert.equal(store.events[0].txHash, "abc");
  });

  test("caps_a_single_tick_at_the_max_billable_seconds", () => {
    const store = fakeStore(SPEC);
    const meter = new StreamingMeter(store, { payTo: "00b76372", maxTickSeconds: 2 });
    const s = meter.openSession("btc-usd", "agent-1");
    // Simulate a long stall: last settlement was an hour ago.
    const session = store.getSession(s.id)!;
    session.lastSettledAt = Date.now() - 3_600_000;
    store.putSession(session);
    const quote = meter.quoteTick(s.id);
    assert.ok(quote.seconds <= 2, `billed ${quote.seconds}s, expected the 2s cap to apply`);
  });

  test("gate_shuts_when_the_stream_is_halted", () => {
    const store = fakeStore(SPEC);
    const meter = new StreamingMeter(store, { payTo: "00b76372", maxTickSeconds: 10 });
    const s = meter.openSession("btc-usd", "agent-1");
    meter.halt(s.id, "tick unpaid");
    assert.throws(() => meter.quoteTick(s.id), (err: unknown) => err instanceof MeterError);
  });
});

describe("the agent decides for itself when to stop paying", () => {
  test("closes_the_gate_when_its_objective_is_met", () => {
    const { policy } = policyForStream("btc-usd", 1);
    const budgetMotes = 1_000_000_000n;
    const ctx = { tick: 1, spentMotes: 0n, nextTickMotes: 1_000_000n, budgetMotes };
    policy.decide({ symbol: "BTC/USD", price: 60000 }, ctx);
    // A move far beyond the trend-hunter threshold must end the session.
    const decision = policy.decide({ symbol: "BTC/USD", price: 66000 }, { ...ctx, tick: 2 });
    assert.equal(decision.keepStreaming, false);
    assert.match(decision.reason, /signal|objective/i);
  });

  test("refuses_a_tick_that_would_breach_its_budget", () => {
    const { policy } = policyForStream("btc-usd", 1);
    const budgetMotes = 1_000_000_000n;
    const decision = policy.decide(
      { symbol: "BTC/USD", price: 60000 },
      { tick: 1, spentMotes: budgetMotes, nextTickMotes: 1_000_000n, budgetMotes },
    );
    assert.equal(decision.keepStreaming, false);
    assert.match(decision.reason, /budget/i);
  });
});
