import { config as loadEnv } from "dotenv";
import type { StreamSpec } from "../../shared/types.ts";
import { MAINNET, TESTNET, explorerFor, parseNetworks } from "../../shared/networks.ts";

loadEnv();

export type Mode = "mock" | "live";

/** A network this server accepts payment on, with the CEP-18 token package payments settle in there. */
export interface NetworkSpec {
  id: string;
  assetPackage: string;
  explorer: string;
}

export interface ServerConfig {
  port: number;
  mode: Mode;
  payTo: string;
  asset: string;
  assetName: string;
  /** Token package on the default network. */
  assetPackage: string;
  /** The default network (the first in `networks`), or "mock". */
  network: string;
  /** Every network LIVE mode accepts payment on, default first. Empty in MOCK mode. */
  networks: NetworkSpec[];
  facilitatorUrl: string;
  facilitatorApiKey: string;
  maxTickSeconds: number;
  snapshotPath: string;
}

/**
 * Networks and their token packages. NETWORKS lists them, default first, for example
 * "casper:casper,casper:casper-test", and each takes its own package from ASSET_PACKAGE_MAINNET or
 * ASSET_PACKAGE_TESTNET. Without NETWORKS, the single-network settings (CAIP2_CHAIN_ID plus
 * ASSET_PACKAGE) still work, so an existing .env keeps its behaviour.
 */
export function networksFromEnv(env: NodeJS.ProcessEnv = process.env): NetworkSpec[] {
  const pkg = (v?: string) => (v || "").trim().replace(/^hash-/, "");
  const ids = parseNetworks(env.NETWORKS);
  if (!ids.length) {
    const id = env.CAIP2_CHAIN_ID || TESTNET;
    return [{ id, assetPackage: pkg(env.ASSET_PACKAGE), explorer: explorerFor(id) }];
  }
  const listed = ids.map((id) => {
    const own = id === MAINNET ? env.ASSET_PACKAGE_MAINNET : id === TESTNET ? env.ASSET_PACKAGE_TESTNET : undefined;
    return { id, assetPackage: pkg(own) || (ids.length === 1 ? pkg(env.ASSET_PACKAGE) : ""), explorer: explorerFor(id) };
  });
  // A network without its own token package is left out, loudly, rather than settling in another
  // network's token or stopping the server: the rest keep working and /health shows what is on.
  const missing = listed.filter((n) => !n.assetPackage).map((n) => n.id);
  if (missing.length) console.warn(`   no token package for ${missing.join(", ")} (set ASSET_PACKAGE_MAINNET / ASSET_PACKAGE_TESTNET); not offering it`);
  return listed.filter((n) => n.assetPackage);
}

export function loadConfig(): ServerConfig {
  const mode = (process.env.MODE === "live" ? "live" : "mock") as Mode;
  const assetName = process.env.ASSET_NAME || "X402";
  const networks = mode === "live" ? networksFromEnv() : [];
  return {
    port: parseInt(process.env.PORT || "4021", 10),
    mode,
    // In MOCK mode a placeholder payee is fine; LIVE mode requires a real Casper address.
    payTo: process.env.PAYEE_ADDRESS || "mock-treasury",
    asset: assetName,
    assetName,
    assetPackage: networks[0]?.assetPackage ?? "",
    network: networks[0]?.id ?? "mock",
    networks,
    facilitatorUrl: process.env.FACILITATOR_URL || "https://x402-facilitator.cspr.cloud",
    facilitatorApiKey: process.env.FACILITATOR_API_KEY || "",
    maxTickSeconds: parseInt(process.env.MAX_TICK_SECONDS || "10", 10),
    // MOCK and LIVE keep SEPARATE snapshots: simulated events must never mix into the on-chain
    // proof data (a mock run once left synthetic rows in the live feed — never again).
    snapshotPath: process.env.SNAPSHOT_PATH || (mode === "live" ? "server/.data/impact.json" : "server/.data/impact.mock.json"),
  };
}

/**
 * The catalogue of metered streams Sluice offers. Rates are motes/second (1 CSPR = 1e9 motes).
 * Each stream pays its provider's own Casper account (Helios Feeds sells two streams into one
 * treasury), so settlements flow to independent on-chain parties, not one shared treasury. That is
 * what makes the /impact feed a real multi-party economy rather than one wallet paying itself.
 */
const HELIOS_FEEDS = process.env.PAYEE_ETH || "0044f9e67c672341bcbcf5f444aa1541072d442526f644196d73eac124c737ad67";

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
    payTo: HELIOS_FEEDS,
  },
  {
    id: "casper-blocks",
    title: "Casper mainnet block feed",
    description: "Live Casper mainnet blocks (height, era, transactions, block age) for agents watching the network.",
    ratePerSecond: "500000", // 0.0005 CSPR/s
    asset: "X402",
    // Helios Feeds' second product, paid to the same treasury as its ETH/USD feed.
    provider: "Helios Feeds",
    payTo: HELIOS_FEEDS,
  },
];

/**
 * Streams no longer offered. They stay listed so settlements already in the proof history keep
 * their provider's name; the meter refuses to open new sessions on them.
 */
export const RETIRED_STREAMS: StreamSpec[] = [
  {
    id: "gpu-telemetry",
    title: "GPU rental telemetry",
    description: "Per-second telemetry for a rented A100 (a labelled simulation, retired 9 Nov 2026).",
    ratePerSecond: "2500000", // 0.0025 CSPR/s
    asset: "X402",
    provider: "NimbusGPU",
    payTo: process.env.PAYEE_GPU || "00fc58cef2cb0adf3ade43868254aae8cfc4601f169e60c7ca6bf3a0f4aa85d491",
    retired: true,
  },
];
