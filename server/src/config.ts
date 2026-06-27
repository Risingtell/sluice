import { config as loadEnv } from "dotenv";
import type { StreamSpec } from "../../shared/types.ts";

loadEnv();

export type Mode = "mock" | "live";

export interface ServerConfig {
  port: number;
  mode: Mode;
  payTo: string;
  asset: string;
  assetName: string;
  assetPackage: string;
  network: string;
  facilitatorUrl: string;
  facilitatorApiKey: string;
  maxTickSeconds: number;
  snapshotPath: string;
}

export function loadConfig(): ServerConfig {
  const mode = (process.env.MODE === "live" ? "live" : "mock") as Mode;
  const assetName = process.env.ASSET_NAME || "X402";
  return {
    port: parseInt(process.env.PORT || "4021", 10),
    mode,
    // In MOCK mode a placeholder payee is fine; LIVE mode requires a real Casper address.
    payTo: process.env.PAYEE_ADDRESS || "mock-treasury",
    asset: assetName,
    assetName,
    assetPackage: (process.env.ASSET_PACKAGE || "").replace(/^hash-/, ""),
    network: mode === "live" ? process.env.CAIP2_CHAIN_ID || "casper:casper-test" : "mock",
    facilitatorUrl: process.env.FACILITATOR_URL || "https://x402-facilitator.cspr.cloud",
    facilitatorApiKey: process.env.FACILITATOR_API_KEY || "",
    maxTickSeconds: parseInt(process.env.MAX_TICK_SECONDS || "10", 10),
    snapshotPath: process.env.SNAPSHOT_PATH || "server/.data/impact.json",
  };
}

/**
 * The catalogue of metered streams Sluice offers. Rates are motes/second (1 CSPR = 1e9 motes).
 * Each stream is supplied by a DISTINCT provider whose `payTo` is that provider's own Casper
 * account — so settlements flow to independent on-chain parties, not one shared treasury. That is
 * what makes the /impact feed a real multi-party economy rather than one wallet paying itself.
 */
export const STREAMS: StreamSpec[] = [
  {
    id: "btc-usd",
    title: "BTC/USD live price",
    description: "Per-second BTC/USD spot feed for trading agents.",
    ratePerSecond: "1000000", // 0.001 CSPR/s
    asset: "X402",
    provider: "Lumen Markets",
    // Dedicated provider treasury (NOT the funding wallet) so settlements flow to an independent party.
    payTo: process.env.PAYEE_BTC || "00b76372880f98f0ddaf31257e32fb5b1b787a7bd9d20642dfac63b32ff7367a12",
  },
  {
    id: "eth-usd",
    title: "ETH/USD live price",
    description: "Per-second ETH/USD spot feed for trading agents.",
    ratePerSecond: "800000", // 0.0008 CSPR/s
    asset: "X402",
    provider: "Helios Feeds",
    payTo: process.env.PAYEE_ETH || "0044f9e67c672341bcbcf5f444aa1541072d442526f644196d73eac124c737ad67",
  },
  {
    id: "gpu-telemetry",
    title: "GPU rental telemetry",
    description: "Per-second telemetry for a rented A100 — pay only while the job runs.",
    ratePerSecond: "2500000", // 0.0025 CSPR/s
    asset: "X402",
    provider: "NimbusGPU",
    payTo: process.env.PAYEE_GPU || "00fc58cef2cb0adf3ade43868254aae8cfc4601f169e60c7ca6bf3a0f4aa85d491",
  },
];
