/**
 * Autonomous consuming agent.
 *
 * Demonstrates the Sluice value prop: the agent opens a stream, pays per second only while it is
 * actually consuming, and SHUTS the stream the instant its strategy no longer needs the data.
 * No subscription, no pre-bought credits — the meter follows the agent's decision.
 *
 * In MOCK mode (D1) the tick just hits POST /next. In LIVE mode (D2) the request is wrapped with
 * x402 payment so each tick is a real on-chain CEP-18 settlement.
 */

import type { Session, SettlementEvent, StreamSpec } from "../../shared/types.ts";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:4021";
const AGENT_ID = process.env.AGENT_ID || `agent-${Math.random().toString(16).slice(2, 8)}`;
const STREAM_ID = process.env.AGENT_STREAM || "btc-usd";
const TICK_MS = parseInt(process.env.AGENT_TICK_MS || "1000", 10);
const MAX_TICKS = parseInt(process.env.AGENT_MAX_TICKS || "20", 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtCspr = (motes: string) => (Number(BigInt(motes)) / 1e9).toFixed(6);

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`${res.status} ${path}: ${err.error || res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Toy strategy: keep streaming until we've seen enough ticks, then decide we're done. */
function strategyWantsMore(tick: number, lastData: unknown): boolean {
  void lastData;
  return tick < MAX_TICKS;
}

async function main(): Promise<void> {
  console.log(`\n🤖 ${AGENT_ID} — streaming "${STREAM_ID}" via Sluice (${SERVER_URL})`);

  const { streams } = await fetch(`${SERVER_URL}/streams`).then((r) => r.json() as Promise<{ streams: StreamSpec[] }>);
  const spec = streams.find((s) => s.id === STREAM_ID);
  if (!spec) throw new Error(`stream ${STREAM_ID} not offered`);
  console.log(`   rate: ${fmtCspr(spec.ratePerSecond)} ${spec.asset}/s\n`);

  const { session } = await post<{ session: Session }>("/sessions", { streamId: STREAM_ID, agent: AGENT_ID });
  console.log(`   session ${session.id} opened\n`);

  let tick = 0;
  let lastData: unknown = null;
  while (strategyWantsMore(tick, lastData)) {
    await sleep(TICK_MS);
    tick++;
    try {
      const r = await post<{ session: Session; settlement: SettlementEvent; data: unknown }>(
        `/sessions/${session.id}/next`,
      );
      lastData = r.data;
      const s = r.settlement;
      const link = s.explorerUrl ? ` ${s.explorerUrl}` : "";
      console.log(
        `   ⛽ tick ${String(tick).padStart(2)} | paid ${fmtCspr(s.amount)} ${s.asset} | ` +
          `total ${fmtCspr(r.session.totalPaid)} | ${s.network}:${s.txHash.slice(0, 12)}…${link}`,
      );
      console.log(`      ↳ ${JSON.stringify(r.data)}`);
    } catch (err) {
      console.error(`   ✋ stream halted: ${(err as Error).message}`);
      break;
    }
  }

  // Agent autonomously decides it's done → close the gate. Meter stops; no further charges.
  const { session: closed } = await post<{ session: Session }>(`/sessions/${session.id}/close`);
  console.log(
    `\n✅ ${AGENT_ID} done. ${closed.ticks} ticks, ` +
      `total paid ${fmtCspr(closed.totalPaid)} ${spec.asset} for ${(closed.settledMs / 1000).toFixed(1)}s of stream.\n`,
  );
}

main().catch((err) => {
  console.error("agent error:", (err as Error).message);
  process.exit(1);
});
