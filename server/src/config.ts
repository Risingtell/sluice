import { config as loadEnv } from "dotenv";
import type { StreamSpec } from "../../shared/types.ts";

loadEnv();

export type Mode = "mock" | "live";

export interface ServerConfig {
  port: number;
  mode: Mode;
  payTo: string;
  asset: string;
  network: string;
  maxTickSeconds: number;
  snapshotPath: string;
}

export function loadConfig(): ServerConfig {
  const mode = (process.env.MODE === "live" ? "live" : "mock") as Mode;
  return {
    port: parseInt(process.env.PORT || "4021", 10),
    mode,
    // In MOCK mode a placeholder payee is fine; LIVE mode requires a real Casper address.
    payTo: process.env.PAYEE_ADDRESS || "mock-treasury",
    asset: process.env.ASSET_NAME || "WCSPR",
    network: mode === "live" ? process.env.CAIP2_CHAIN_ID || "casper:casper-test" : "mock",
    maxTickSeconds: parseInt(process.env.MAX_TICK_SECONDS || "10", 10),
    snapshotPath: process.env.SNAPSHOT_PATH || "server/.data/impact.json",
  };
}

/** The catalogue of metered streams Sluice offers. Rates are motes/second (1 CSPR = 1e9 motes). */
export const STREAMS: StreamSpec[] = [
  {
    id: "btc-usd",
    title: "BTC/USD live price",
    description: "Per-second BTC/USD spot feed for trading agents.",
    ratePerSecond: "1000000", // 0.001 CSPR/s
    asset: "WCSPR",
  },
  {
    id: "eth-usd",
    title: "ETH/USD live price",
    description: "Per-second ETH/USD spot feed for trading agents.",
    ratePerSecond: "800000", // 0.0008 CSPR/s
    asset: "WCSPR",
  },
  {
    id: "gpu-telemetry",
    title: "GPU rental telemetry",
    description: "Per-second telemetry for a rented A100 — pay only while the job runs.",
    ratePerSecond: "2500000", // 0.0025 CSPR/s
    asset: "WCSPR",
  },
];
