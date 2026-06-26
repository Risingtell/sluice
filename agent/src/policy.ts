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
  const threshold = opts.thresholdPct ?? 0.4;
  const patience = opts.patienceTicks ?? 8;
  let entry: number | null = null;
  return {
    name: "trend-hunter",
    objective: `act on a ≥${threshold}% price move`,
    decide(chunk, ctx) {
      const guard = budgetOk(ctx);
      if (guard) return guard;
      const price = Number(chunk?.price);
      if (!Number.isFinite(price)) return { keepStreaming: true, reason: "warming up" };
      if (entry === null) entry = price;
      const move = ((price - entry) / entry) * 100;
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
 * JobRunner — an agent renting GPU telemetry while a job runs. It pays for the duration of the job
 * (`targetTicks` of work) but aborts immediately if the GPU crosses a safety temperature, because
 * paying for an overheating box isn't worth it. Either way the agent closes the gate on its own.
 */
export function jobRunner(opts: { targetTicks?: number; maxTempC?: number } = {}): AgentPolicy {
  const target = opts.targetTicks ?? 6;
  const maxTemp = opts.maxTempC ?? 78;
  return {
    name: "job-runner",
    objective: `run job for ${target} ticks unless GPU > ${maxTemp}°C`,
    decide(chunk, ctx) {
      const guard = budgetOk(ctx);
      if (guard) return guard;
      const temp = Number(chunk?.tempC);
      if (Number.isFinite(temp) && temp > maxTemp) {
        return { keepStreaming: false, reason: `GPU ${temp}°C > ${maxTemp}°C — aborted job, gate closed` };
      }
      if (ctx.tick >= target) {
        return { keepStreaming: false, reason: `job complete (${target} ticks) — gate closed` };
      }
      return { keepStreaming: true, reason: `job running (${Number.isFinite(temp) ? temp + "°C" : "…"})` };
    },
  };
}

/** Pick a sensible default policy for a stream when one isn't named explicitly. */
export function policyForStream(streamId: string, budgetX402: number): { policy: AgentPolicy } {
  if (streamId === "gpu-telemetry") return { policy: jobRunner() };
  return { policy: trendHunter() };
}
