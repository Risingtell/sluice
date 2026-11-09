/**
 * Agent policies — what makes a Sluice consumer *agentic* rather than a fixed payment loop.
 *
 * Each policy gives the agent an OBJECTIVE and a BUDGET, and a `decide()` it runs every tick against
 * the freshly-streamed data. The agent keeps paying (the gate stays open) only while `decide` says
 * the stream is still worth it; the moment the objective is met, the data stops being useful, or the
 * budget would be exceeded, the agent closes the gate itself. That self-directed cutoff — not a tick
 * counter — is the agency.
 */

export interface DecisionContext {
  /** 1-based tick index (number of paid ticks so far). */
  tick: number;
  /** Total motes spent by this agent on this session so far. */
  spentMotes: bigint;
  /** Motes the next tick is expected to cost (rate × tick seconds). */
  nextTickMotes: bigint;
  /** Budget ceiling in motes for the whole session. */
  budgetMotes: bigint;
}

export interface Decision {
  /** Keep the stream open and pay the next tick? */
  keepStreaming: boolean;
  /** Human-readable why — surfaced in logs and on the public proof feed. */
  reason: string;
}

export interface AgentPolicy {
  readonly name: string;
  readonly objective: string;
  /** Evaluate the latest streamed chunk and decide whether to keep paying. */
  decide(chunk: any, ctx: DecisionContext): Decision;
}

/** Shared budget guard: never authorize a tick that would blow the budget. */
function budgetOk(ctx: DecisionContext): Decision | null {
  if (ctx.spentMotes + ctx.nextTickMotes > ctx.budgetMotes) {
    return { keepStreaming: false, reason: `budget reached (${fmt(ctx.spentMotes)} X402 spent) — gate closed` };
  }
  return null;
}

const fmt = (m: bigint) => (Number(m) / 1e9).toFixed(6);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

/**
 * TrendHunter — a trading agent renting a live price feed. It watches for a price move of at least
 * `thresholdPct` from the price it first observed: once it sees the signal it has what it needs and
 * stops paying (objective met). If no signal appears within its patience window, it gives up to stop
 * burning budget on a quiet market.
 */
export function trendHunter(opts: { thresholdPct?: number; patienceTicks?: number } = {}): AgentPolicy {
  // Tuned for a real spot feed: BTC/ETH routinely drift a few hundredths of a percent over the short
  // window an agent streams, so a scalp-sized threshold lets the agent act on genuine market moves.
  const threshold = opts.thresholdPct ?? 0.05;
  const patience = opts.patienceTicks ?? 8;
  let entry: { price: number; source: string } | null = null;
  return {
    name: "trend-hunter",
    objective: `act on a ≥${threshold}% price move`,
    decide(chunk, ctx) {
      const guard = budgetOk(ctx);
      if (guard) return guard;
      const price = Number(chunk?.price);
      if (!Number.isFinite(price)) return { keepStreaming: true, reason: "warming up" };
      // A move is only meaningful between quotes from the same source. When the feed switches
      // between its fallback and the real market price, re-anchor instead of reading the gap as a signal.
      const source = String(chunk?.source ?? "");
      if (entry === null || entry.source !== source) {
        const switched = entry !== null;
        entry = { price, source };
        if (switched && ctx.tick < patience) {
          return { keepStreaming: true, reason: `price source changed to ${source || "unknown"}, re-anchored` };
        }
      }
      const move = ((price - entry.price) / entry.price) * 100;
      if (Math.abs(move) >= threshold) {
        return { keepStreaming: false, reason: `signal: ${pct(move)} move detected — objective met, gate closed` };
      }
      if (ctx.tick >= patience) {
        return { keepStreaming: false, reason: `no signal in ${patience} ticks (${pct(move)}) — gate closed to save budget` };
      }
      return { keepStreaming: true, reason: `watching (${pct(move)})` };
    },
  };
}

/**
 * BlockWatcher: an agent watching Casper mainnet block production. It pays per second until it has
 * seen `targetBlocks` new blocks, then closes the gate with the heights it saw. It stops early when
 * the data is not worth paying for: the network looks stalled (the newest block is older than
 * `maxBlockAgeSec`), or the feed has served stale readings for `maxStaleTicks` ticks in a row.
 */
export function blockWatcher(opts: { targetBlocks?: number; maxBlockAgeSec?: number; maxStaleTicks?: number } = {}): AgentPolicy {
  const target = opts.targetBlocks ?? 2;
  const maxAge = opts.maxBlockAgeSec ?? 60;
  const maxStale = opts.maxStaleTicks ?? 3;
  let first: number | null = null;
  let stale = 0;
  return {
    name: "block-watcher",
    objective: `see ${target} new Casper mainnet blocks`,
    decide(chunk, ctx) {
      const guard = budgetOk(ctx);
      if (guard) return guard;
      const height = Number(chunk?.height);
      if (chunk?.live !== true || !Number.isFinite(height)) {
        stale++;
        if (stale >= maxStale) return { keepStreaming: false, reason: `feed not live for ${stale} ticks, stopped paying for stale data` };
        return { keepStreaming: true, reason: "waiting for a fresh block reading" };
      }
      stale = 0;
      const age = Number(chunk?.secondsSinceBlock);
      if (Number.isFinite(age) && age > maxAge) {
        return { keepStreaming: false, reason: `no new block for ${age}s, network looks stalled, gate closed` };
      }
      if (first === null) first = height;
      const seen = height - first;
      if (seen >= target) {
        return { keepStreaming: false, reason: `saw ${seen} new mainnet blocks (${first} to ${height}), objective met, gate closed` };
      }
      return { keepStreaming: true, reason: `watching block ${height} (${seen}/${target} new)` };
    },
  };
}

/** Pick a sensible default policy for a stream when one isn't named explicitly. */
export function policyForStream(streamId: string, budgetX402: number): { policy: AgentPolicy } {
  if (streamId === "casper-blocks") return { policy: blockWatcher() };
  return { policy: trendHunter() };
}
