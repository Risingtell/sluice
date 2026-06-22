/**
 * Synthetic continuous data feeds. Each stream produces a fresh chunk per paid tick — this stands
 * in for any real continuous resource an agent would meter (live market data, a sensor stream,
 * inference tokens, GPU time). The point is that the chunk is delivered ONLY because the tick paid.
 */

const prices = new Map<string, number>();

function nextPrice(streamId: string, seed: number): number {
  const last = prices.get(streamId) ?? seed;
  // bounded random walk
  const drift = (Math.random() - 0.5) * seed * 0.004;
  const next = Math.max(seed * 0.5, last + drift);
  prices.set(streamId, next);
  return Math.round(next * 100) / 100;
}

export function nextChunk(streamId: string, tick: number): unknown {
  switch (streamId) {
    case "btc-usd":
      return { symbol: "BTC/USD", price: nextPrice(streamId, 64000), tick, ts: Date.now() };
    case "eth-usd":
      return { symbol: "ETH/USD", price: nextPrice(streamId, 3400), tick, ts: Date.now() };
    case "gpu-telemetry":
      return {
        gpu: "A100-80GB",
        utilizationPct: Math.round(60 + Math.random() * 40),
        tempC: Math.round(55 + Math.random() * 25),
        tick,
        ts: Date.now(),
      };
    default:
      return { streamId, tick, ts: Date.now() };
  }
}
