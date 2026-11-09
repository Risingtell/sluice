/**
 * Streamed resource feeds. Each stream produces a fresh chunk per paid tick — delivered ONLY because
 * the tick was paid.
 *
 * Price streams (BTC/USD, ETH/USD) serve a REAL market price: a background poller pulls live spot
 * from CoinGecko every ~15s and caches it, so each tick returns a genuine quote (`source:"coingecko",
 * live:true`). If the upstream is briefly unreachable we fall back to a bounded random walk
 * (`live:false`) so a demo never stalls.
 *
 * The Casper block feed serves REAL Casper mainnet blocks read from a public Casper node
 * (`source:"casper-node"`). The node is read when a tick is paid, at most once every 3 seconds, so
 * an idle server never touches it. It never invents a block: if the node cannot be reached, the
 * last reading is served and marked `live:false` once it is 15 seconds old.
 */

import { casperChunk, parseCasperBlock, type CasperBlock } from "./casper-block.ts";

interface RealPrice {
  price: number;
  ts: number;
}

const real = new Map<string, RealPrice>(); // streamId -> latest real price
const walk = new Map<string, { anchor: number; price: number }>(); // streamId -> synthetic walk (fallback)

const COINGECKO = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd";
const COIN_BY_STREAM: Record<string, string> = { "btc-usd": "bitcoin", "eth-usd": "ethereum" };
const FRESH_MS = 90_000;

async function poll(): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(COINGECKO, { signal: ctrl.signal, headers: { accept: "application/json" } });
    clearTimeout(t);
    if (!res.ok) return;
    const j = (await res.json()) as Record<string, { usd?: number }>;
    for (const [streamId, coin] of Object.entries(COIN_BY_STREAM)) {
      const p = Number(j?.[coin]?.usd);
      if (Number.isFinite(p) && p > 0) real.set(streamId, { price: p, ts: Date.now() });
    }
  } catch {
    /* keep last known; the synthetic fallback covers any gap */
  }
}

// Start polling immediately, then on an interval. unref so it never holds the process open.
void poll();
const timer = setInterval(() => void poll(), 10_000);
(timer as { unref?: () => void }).unref?.();

/**
 * Bounded random walk used only until the first real price lands (or if upstream is down). It walks
 * from the last real price when there is one, so a fallback quote stays near the actual market
 * instead of near a seed that has gone stale.
 */
function syntheticPrice(streamId: string, seed: number): number {
  const anchor = real.get(streamId)?.price ?? seed;
  const w = walk.get(streamId);
  const last = w && w.anchor === anchor ? w.price : anchor;
  const drift = (Math.random() - 0.5) * anchor * 0.004;
  const next = Math.max(anchor * 0.5, last + drift);
  walk.set(streamId, { anchor, price: next });
  return Math.round(next * 100) / 100;
}

function priceChunk(symbol: string, streamId: string, seed: number, tick: number) {
  const r = real.get(streamId);
  if (r && Date.now() - r.ts < FRESH_MS) {
    return { symbol, price: r.price, tick, ts: Date.now(), source: "coingecko", live: true };
  }
  return { symbol, price: syntheticPrice(streamId, seed), tick, ts: Date.now(), source: "synthetic", live: false };
}

// ── Casper mainnet block feed ────────────────────────────────────────────────────────────────────

const CASPER_RPC = process.env.CASPER_FEED_RPC || "https://node.mainnet.casper.network/rpc";
/** Read the node again when the last reading is older than this (mainnet makes a block about every 8 s). */
const CASPER_REFRESH_MS = 3000;

let casperLatest: CasperBlock | undefined;
let casperReading: Promise<void> | undefined;

/**
 * Read the latest block. Concurrent ticks share one request, and the timeout covers the whole
 * answer, body included, so a node that stalls mid-answer can never wedge the feed.
 */
function readCasper(): Promise<void> {
  casperReading ??= (async () => {
    try {
      const res = await fetch(CASPER_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain_get_block" }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return;
      const block = parseCasperBlock(((await res.json()) as { result?: unknown })?.result, Date.now());
      if (!block) return;
      if (!casperLatest || block.height >= casperLatest.height) casperLatest = block;
      // A node one block behind still shows the network is alive: keep the newer block, now fresh.
      else casperLatest = { ...casperLatest, fetchedAt: block.fetchedAt };
    } catch {
      /* keep the last reading; it is served as not live once it ages */
    } finally {
      casperReading = undefined;
    }
  })();
  return casperReading;
}

/** The block is read when the tick is paid for, so the agent always gets the network as it is now. */
async function nextCasperChunk(tick: number) {
  if (!casperLatest || Date.now() - casperLatest.fetchedAt > CASPER_REFRESH_MS) await readCasper();
  return casperChunk(casperLatest, tick, Date.now());
}

export async function nextChunk(streamId: string, tick: number): Promise<unknown> {
  switch (streamId) {
    case "btc-usd":
      return priceChunk("BTC/USD", "btc-usd", 81600, tick);
    case "eth-usd":
      return priceChunk("ETH/USD", "eth-usd", 2400, tick);
    case "casper-blocks":
      return nextCasperChunk(tick);
    default:
      return { streamId, tick, ts: Date.now() };
  }
}
