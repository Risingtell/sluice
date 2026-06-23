/**
 * Autonomous consuming agent.
 *
 * Demonstrates the Sluice value prop: the agent opens a stream, pays per second only while it is
 * actually consuming, and SHUTS the stream the instant its strategy no longer needs the data.
 *
 * MOCK mode: each tick is a plain POST /tick (synthetic settlement).
 * LIVE mode (MODE=live): each tick is wrapped with x402 payment — a real on-chain CEP-18
 * transfer_with_authorization signed by the agent's Casper key, settled via the facilitator.
 */
import { config as loadEnv } from "dotenv";
import type { Session, SettlementEvent, StreamSpec } from "../../shared/types.ts";

loadEnv();

const MODE = process.env.MODE === "live" ? "live" : "mock";
const SERVER_URL = process.env.SERVER_URL || "http://localhost:4021";
const STREAM_ID = process.env.AGENT_STREAM || "btc-usd";
const TICK_MS = parseInt(process.env.AGENT_TICK_MS || "1000", 10);
const MAX_TICKS = parseInt(process.env.AGENT_MAX_TICKS || "20", 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (units: string) => (Number(BigInt(units)) / 1e9).toFixed(6);

type TickFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Build the payment-wrapped fetch + agent identity for LIVE mode. */
async function buildLive(): Promise<{ tickFetch: TickFetch; agentId: string; readTx: (r: Response) => string }> {
  const { x402Client, x402HTTPClient, wrapFetchWithPayment } = await import("@x402/fetch");
  const { createClientCasperSigner } = await import("@make-software/casper-x402");
  const { ExactCasperScheme } = await import("@make-software/casper-x402/exact/client");
  const casperMod = await import("casper-js-sdk");
  const casperSdk = (casperMod as any).default ?? casperMod;
  const { KeyAlgorithm } = casperSdk;

  const keyPath = process.env.CLIENT_PRIVATE_KEY_PATH;
  if (!keyPath) throw new Error("LIVE mode requires CLIENT_PRIVATE_KEY_PATH");
  const algo = process.env.CLIENT_KEY_ALGO === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const signer = await createClientCasperSigner(keyPath, algo);

  const selector = (_v: number, options: any[]) => options.find((o) => o.network.startsWith("casper:")) ?? options[0];
  const client = new x402Client(selector).register("casper:*", new ExactCasperScheme(signer));
  const httpClient = new x402HTTPClient(client);
  const tickFetch = wrapFetchWithPayment(fetch, client) as TickFetch;

  return {
    tickFetch,
    agentId: signer.accountAddress(),
    readTx: (r) => httpClient.getPaymentSettleResponse((n: string) => r.headers.get(n))?.transaction ?? "",
  };
}

async function jsonPost<T>(path: string, body?: unknown): Promise<T> {
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

async function main(): Promise<void> {
  const live = MODE === "live";
  const liveBits = live ? await buildLive() : null;
  const agentId = liveBits?.agentId ?? process.env.AGENT_ID ?? `agent-${Math.random().toString(16).slice(2, 8)}`;

  console.log(`\n🤖 ${agentId}`);
  console.log(`   mode: ${MODE.toUpperCase()} · stream "${STREAM_ID}" via ${SERVER_URL}\n`);

  const { streams } = await fetch(`${SERVER_URL}/streams`).then((r) => r.json() as Promise<{ streams: StreamSpec[] }>);
  const spec = streams.find((s) => s.id === STREAM_ID);
  if (!spec) throw new Error(`stream ${STREAM_ID} not offered`);
  console.log(`   rate: ${fmt(spec.ratePerSecond)} ${spec.asset}/s\n`);

  const { session } = await jsonPost<{ session: Session }>("/sessions", { streamId: STREAM_ID, agent: agentId });
  console.log(`   session ${session.id} opened\n`);

  const tickUrl = `${SERVER_URL}/tick?session=${session.id}`;
  let tick = 0;
  let totalPaid = 0n;
  while (tick < MAX_TICKS) {
    await sleep(TICK_MS);
    tick++;
    try {
      if (live && liveBits) {
        const res = await liveBits.tickFetch(tickUrl, { method: "POST" });
        if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);
        const body = (await res.json()) as { session: Session; data: unknown };
        const txHash = liveBits.readTx(res);
        totalPaid = BigInt(body.session.totalPaid);
        console.log(
          `   ⛽ tick ${String(tick).padStart(2)} | total ${fmt(body.session.totalPaid)} ${spec.asset} | ` +
            `${txHash ? "tx " + txHash.slice(0, 14) + "…  https://testnet.cspr.live/deploy/" + txHash : "(settling)"}`,
        );
        console.log(`      ↳ ${JSON.stringify(body.data)}`);
      } else {
        const r = await jsonPost<{ session: Session; settlement: SettlementEvent; data: unknown }>(
          `/tick?session=${session.id}`,
        );
        totalPaid = BigInt(r.session.totalPaid);
        console.log(
          `   ⛽ tick ${String(tick).padStart(2)} | paid ${fmt(r.settlement.amount)} ${spec.asset} | ` +
            `total ${fmt(r.session.totalPaid)} | ${r.settlement.network}:${r.settlement.txHash.slice(0, 12)}…`,
        );
        console.log(`      ↳ ${JSON.stringify(r.data)}`);
      }
    } catch (err) {
      console.error(`   ✋ stream halted: ${(err as Error).message}`);
      break;
    }
  }

  const { session: closed } = await jsonPost<{ session: Session }>(`/sessions/${session.id}/close`);
  console.log(
    `\n✅ ${agentId} done. ${closed.ticks} ticks, total paid ${fmt(closed.totalPaid || totalPaid.toString())} ${spec.asset}.\n`,
  );
}

main().catch((err) => {
  console.error("agent error:", err?.response?.data?.error ?? (err as Error).message ?? err);
  process.exit(1);
});
