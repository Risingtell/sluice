/**
 * Streamed resource feeds. Each stream produces a fresh chunk per paid tick — delivered ONLY because
 * the tick was paid.
 *
 * Price streams (BTC/USD, ETH/USD) serve a REAL market price: a background poller pulls live spot
 * from CoinGecko every ~15s and caches it, so each tick returns a genuine quote (`source:"coingecko",
 * live:true`). If the upstream is briefly unreachable we fall back to a bounded random walk
 * (`live:false`) so a demo never stalls. GPU telemetry is an honestly-labelled simulation
 * (`source:"simulated"`) — the point Sluice proves is the per-second payment mechanism, and for the
 * price feeds the metered resource is now real.
 */

interface RealPrice {
  price: number;
  ts: number;
}

const real = new Map<string, RealPrice>(); // streamId -> latest real price
const walk = new Map<string, number>(); // streamId -> last synthetic price (fallback)

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

/** Bounded random walk used only until the first real price lands (or if upstream is down). */
function syntheticPrice(streamId: string, seed: number): number {
  const last = walk.get(streamId) ?? seed;
  const drift = (Math.random() - 0.5) * seed * 0.004;
  const next = Math.max(seed * 0.5, last + drift);
  walk.set(streamId, next);
  return Math.round(next * 100) / 100;
}

function priceChunk(symbol: string, streamId: string, seed: number, tick: number) {
  const r = real.get(streamId);
  if (r && Date.now() - r.ts < FRESH_MS) {
    return { symbol, price: r.price, tick, ts: Date.now(), source: "coingecko", live: true };
  }
  return { symbol, price: syntheticPrice(streamId, seed), tick, ts: Date.now(), source: "synthetic", live: false };
}

export function nextChunk(streamId: string, tick: number): unknown {
  switch (streamId) {
    case "btc-usd":
      return priceChunk("BTC/USD", "btc-usd", 64000, tick);
    case "eth-usd":
      return priceChunk("ETH/USD", "eth-usd", 3400, tick);
    case "gpu-telemetry":
      return {
        gpu: "A100-80GB",
        utilizationPct: Math.round(60 + Math.random() * 40),
        tempC: Math.round(55 + Math.random() * 25),
        tick,
        ts: Date.now(),
        source: "simulated",
      };
    default:
      return { streamId, tick, ts: Date.now() };
  }
}
