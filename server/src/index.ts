import cors from "cors";
import express from "express";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, RETIRED_STREAMS, STREAMS } from "./config.ts";
import { tokenProfile } from "../../shared/tokens.ts";
import { clientIpInfo } from "../../shared/client-ip.ts";
import { Store } from "./store.ts";
import { StreamingMeter, MeterError } from "./meter.ts";
import { MockSettlementProvider, type SettlementProvider } from "./settlement.ts";
import { mountCasperLive } from "./casper-live.ts";
import { mountDemo, seedSnapshot } from "./demo.ts";
import { createFacilitatorRouter, facilitatorOptionsFromEnv } from "../../facilitator/src/router.ts";
import { faucetNetworks, mountFaucet } from "./faucet.ts";
import { nextChunk } from "./feed.ts";
import type { ImpactSnapshot, OpenSessionRequest, TickResponse } from "../../shared/types.ts";

const cfg = loadConfig();
const __dirname = dirname(fileURLToPath(import.meta.url));

// Cloud-host bootstrap: materialize the agent signing key from an env var (fresh containers have
// no keys/ directory), and seed the proof snapshot from the committed real history.
const keyPath = process.env.CLIENT_PRIVATE_KEY_PATH || "keys/agent.pem";
if (process.env.AGENT_KEY_PEM && !existsSync(keyPath)) {
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, process.env.AGENT_KEY_PEM);
  console.log(`   materialized agent key at ${keyPath}`);
}
seedSnapshot(cfg.snapshotPath);

// Retired streams stay in the lookup so the proof history keeps their providers' names; /streams
// and the meter offer only the live catalogue.
const streams = new Map([...STREAMS, ...RETIRED_STREAMS].map((s) => [s.id, s]));
const store = new Store(streams, cfg.snapshotPath);

/**
 * LIVE preflight: confirm the facilitator is reachable and within quota BEFORE mounting the
 * payment middleware. Without this, quota exhaustion (~300 calls/day, shared) makes the server
 * crash at init; a public demo must degrade gracefully instead.
 */
/**
 * Narrows the networks this server sponsors, and drops any network left with no way to pay on it
 * (not sponsored, and buyer-settle not offered there).
 */
function applySponsored(sponsored: string[]): void {
  cfg.sponsoredNetworks = sponsored;
  cfg.networks = cfg.networks.filter((n) => sponsored.includes(n.id) || cfg.buyerSettleNetworks.includes(n.id));
  cfg.network = cfg.networks[0]?.id ?? cfg.network;
  cfg.assetPackage = cfg.networks[0]?.assetPackage ?? cfg.assetPackage;
}

async function facilitatorReady(): Promise<boolean> {
  if (cfg.mode !== "live") return false;
  // Buyer-settle needs no facilitator: with nothing to sponsor there is nothing to check.
  if (!cfg.sponsoredNetworks.length) return cfg.networks.length > 0;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${cfg.facilitatorUrl}/supported`, {
      headers: { Authorization: cfg.facilitatorApiKey },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(`   facilitator preflight: HTTP ${res.status}; not sponsoring gas anywhere`);
      applySponsored([]);
      return cfg.networks.length > 0;
    }
    // A remote facilitator may not settle on every network we sell on. Offering one it cannot
    // settle makes every 402 fail to build, testnet included, so offer only what it supports.
    const body = (await res.json().catch(() => ({}))) as { kinds?: { scheme?: string; network?: string }[] };
    const supported = new Set((body.kinds ?? []).filter((k) => k.scheme === "exact").map((k) => String(k.network)));
    const dropped = cfg.sponsoredNetworks.filter((id) => !supported.has(id));
    if (dropped.length) console.warn(`   facilitator ${cfg.facilitatorUrl} does not settle on ${dropped.join(", ")}; not sponsoring it`);
    applySponsored(cfg.sponsoredNetworks.filter((id) => supported.has(id)));
    return cfg.networks.length > 0;
  } catch (err) {
    console.warn(`   facilitator preflight failed (${(err as Error).message}); not sponsoring gas anywhere`);
    applySponsored([]);
    return cfg.networks.length > 0;
  }
}

/**
 * Self-hosted facilitator (default in LIVE mode; set SELF_FACILITATOR=0 to use a remote one).
 *
 * The public hosted facilitator builds the CEP-18 settle call with the runtime argument named
 * `value`, while the reference Cep18X402 token reads `amount`, so every settlement it attempts
 * reverts on-chain. Running the official scheme in-process makes the argument names agree by
 * construction and keeps Sluice on its existing token and ledger.
 *
 * It is mounted on this same app, so there is no second service to deploy or wake. Construction is
 * the readiness check: it loads the fee-payer key and registers the scheme, so if it succeeds the
 * facilitator is live. The HTTP preflight is skipped in this mode because the server is not
 * listening yet at this point in startup.
 */
let selfFacilitator: Awaited<ReturnType<typeof createFacilitatorRouter>> | null = null;
// It only ever serves the networks this server sponsors, so its fee payer never signs on any other.
if (cfg.mode === "live" && cfg.sponsoredNetworks.length && process.env.SELF_FACILITATOR !== "0") {
  try {
    selfFacilitator = await createFacilitatorRouter({ ...facilitatorOptionsFromEnv(), networks: [...cfg.sponsoredNetworks] });
    cfg.facilitatorUrl = `http://127.0.0.1:${cfg.port}/facilitator`;
    console.log(`   self-hosted facilitator: fee payer ${selfFacilitator.feePayer.join(", ").slice(0, 24)}`);
  } catch (err) {
    console.warn(`   self-hosted facilitator unavailable (${(err as Error).message}); falling back to ${cfg.facilitatorUrl}`);
  }
}

const liveReady = selfFacilitator ? true : await facilitatorReady();

const meter = new StreamingMeter(store, { payTo: cfg.payTo, maxTickSeconds: cfg.maxTickSeconds });

// MOCK path provider. In LIVE mode the @x402/express middleware settles instead (D4), driving
// meter.commitTick() from its AfterSettleHook with the real CEP-18 transfer hash.
const provider: SettlementProvider = new MockSettlementProvider();

const app = express();
app.use(cors());
app.use(express.json());

// The self-hosted facilitator shares this process, so the resource server reaches it over loopback.
if (selfFacilitator) app.use("/facilitator", selfFacilitator.router);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mode: cfg.mode,
    network: cfg.network,
    networks: cfg.networks.map((n) => n.id),
    liveSettlement: cfg.mode !== "live" || liveReady,
    // Who pays the gas for each payment, per network: this server ("exact") or the buyer ("buyer-settle").
    ...(cfg.mode === "live" ? { sponsoredNetworks: cfg.sponsoredNetworks, buyerSettleNetworks: cfg.buyerSettleNetworks } : {}),
    // Where the per-visitor limits found this caller's address: the proxy header, or the socket.
    clientIpFrom: clientIpInfo(req).from,
  });
});

// The token each network is paid in, by the symbol settlements are recorded under (X402 or
// WCSPR), and the label the proof feed shows for it (the configured name for the X402 token).
const symbolOn = (network?: string): string => tokenProfile(cfg.networks.find((n) => n.id === network)?.assetPackage ?? "", cfg.asset).symbol;
const assetOn = (network?: string): string => (symbolOn(network) === "WCSPR" ? "WCSPR" : cfg.asset);
const networkAssets: Record<string, string> = Object.fromEntries(cfg.networks.map((n) => [n.id, symbolOn(n.id)]));
const servedAssets = [...new Set(Object.values(networkAssets))];

app.get("/streams", (_req, res) => {
  // Rates are in the token's smallest unit. When every network takes the same token, each stream
  // names it; `assets` always says which token each network takes.
  const streams = servedAssets.length === 1 ? STREAMS.map((s) => ({ ...s, asset: servedAssets[0] })) : STREAMS;
  res.json({ streams, assets: networkAssets });
});

// Open a streaming session.
app.post("/sessions", (req, res) => {
  const body = req.body as OpenSessionRequest;
  if (!body?.streamId || !body?.agent) {
    return res.status(400).json({ error: "streamId and agent are required" });
  }
  try {
    const session = meter.openSession(body.streamId, body.agent, { policy: body.policy, objective: body.objective });
    res.status(201).json({ session });
  } catch (err) {
    sendMeterError(res, err);
  }
});

// Settle one tick and receive the next chunk: POST /tick?session=<id>.
// LIVE mode wraps this with @x402/express paymentMiddleware (see mountCasperLive); each tick is a
// real on-chain CEP-18 settlement. MOCK mode settles synthetically here.
if (cfg.mode === "live" && liveReady) {
  mountCasperLive(app, cfg, meter);
} else if (cfg.mode === "live") {
  // Degraded live mode: never settle synthetically into the on-chain proof store. The /demo
  // endpoints still work (simulation runs against a separate store); paid ticks wait for quota.
  app.post("/tick", (_req, res) => {
    res.status(503).json({ error: "live settlement temporarily unavailable (facilitator quota); try the /demo console" });
  });
} else {
  app.post("/tick", async (req, res) => {
    const sessionId = (req.query.session as string) || "";
    try {
      const quote = meter.quoteTick(sessionId);
      let result;
      try {
        result = await provider.settle(quote);
      } catch (err) {
        meter.halt(sessionId, (err as Error).message || "settlement failed");
        return res.status(402).json({ error: `tick unpaid — stream halted: ${(err as Error).message}` });
      }
      const { session, event } = meter.commitTick(quote, result);
      const data = await nextChunk(session.streamId, session.ticks);
      const payload: TickResponse = { session, settlement: event, data };
      res.json(payload);
    } catch (err) {
      sendMeterError(res, err);
    }
  });
}

app.get("/sessions/:id", (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "unknown session" });
  res.json({ session });
});

app.post("/sessions/:id/close", (req, res) => {
  try {
    const reason = (req.body as { reason?: string })?.reason;
    res.json({ session: meter.closeSession(req.params.id, reason) });
  } catch (err) {
    sendMeterError(res, err);
  }
});

// Public proof feed (machine-readable). The /impact.html page renders this live. One network at a
// time: the testnet proof feed by default (where the on-chain registry anchors the totals), and
// ?network=casper:casper for mainnet. Mainnet and testnet are never added together.
const liveNetworks = cfg.networks.map((n) => n.id);
const proofNetwork = liveNetworks.includes("casper:casper-test") ? "casper:casper-test" : cfg.network;
app.get("/impact", (req, res) => {
  const asked = typeof req.query.network === "string" ? req.query.network : "";
  const counts = store.settlementsByNetwork();
  // MOCK mode's snapshot holds the seeded testnet history plus simulated rows. Its dashboard shows
  // all of it, as it always has; ?network= narrows it. LIVE mode shows one network at a time.
  const known = cfg.mode === "live" ? liveNetworks : [...new Set([cfg.network, ...counts.keys()])];
  if (asked && !known.includes(asked)) {
    return res.status(400).json({ error: `network must be one of ${known.join(", ")}` });
  }
  const network = asked || (cfg.mode === "live" ? proofNetwork : undefined);
  const t = store.totals(network);
  const symbol = symbolOn(network);
  const snapshot: ImpactSnapshot = {
    network: network ?? cfg.network,
    networks: known.map((id) => ({ id, settlements: counts.get(id) ?? 0 })),
    mock: cfg.mode === "mock",
    totals: {
      settlements: t.settlements,
      // The token this network is paid in now (WCSPR on a WCSPR network), and only amounts paid in
      // it: a history that changed token keeps each token's total apart in paidByAsset.
      totalPaid: (t.paidByAsset.get(symbol) ?? 0n).toString(),
      asset: assetOn(network),
      paidByAsset: [...t.paidByAsset].map(([a, amount]) => ({ asset: a, amount: amount.toString() })),
      activeSessions: store.activeSessionCount(),
      uniqueAgents: t.uniqueAgents,
      uniqueProviders: t.uniqueProviders,
      secondsStreamed: Math.round(t.secondsStreamed),
    },
    recent: store.recentEvents(50, network),
    decisions: store.recentDecisions(8),
  };
  res.json(snapshot);
});

// Judge-facing demo console: one click runs a real (or clearly-labelled simulated) agent session.
// Token faucet, so a third-party agent can onboard itself instead of asking us for tokens.
// LIVE only: in MOCK mode settlement is synthetic and no token is needed.
// The faucet hands out free test tokens on test networks only (see faucet.ts); none on mainnet.
if (cfg.mode === "live" && faucetNetworks(cfg).length) mountFaucet(app, cfg);

mountDemo(app, cfg, cfg.mode === "live" && liveReady);

app.use(express.static(join(__dirname, "..", "public")));

app.listen(cfg.port, () => {
  console.log(`\n💧 Sluice resource server`);
  console.log(`   mode:    ${cfg.mode.toUpperCase()}${cfg.mode === "mock" ? " (no creds needed)" : ""}`);
  console.log(`   network: ${cfg.mode === "live" ? cfg.networks.map((n) => n.id).join(", ") + " (default first)" : cfg.network}`);
  console.log(`   listen:  http://localhost:${cfg.port}`);
  console.log(`   impact:  http://localhost:${cfg.port}/impact.html\n`);
});

function sendMeterError(res: express.Response, err: unknown): void {
  if (err instanceof MeterError) {
    res.status(err.status).json({ error: err.message });
  } else {
    console.error(err);
    res.status(500).json({ error: (err as Error).message || "internal error" });
  }
}
