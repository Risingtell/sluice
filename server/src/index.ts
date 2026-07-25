import cors from "cors";
import express from "express";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, STREAMS } from "./config.ts";
import { Store } from "./store.ts";
import { StreamingMeter, MeterError } from "./meter.ts";
import { MockSettlementProvider, type SettlementProvider } from "./settlement.ts";
import { mountCasperLive } from "./casper-live.ts";
import { mountDemo, seedSnapshot } from "./demo.ts";
import { createFacilitatorRouter, facilitatorOptionsFromEnv } from "../../facilitator/src/router.ts";
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

const streams = new Map(STREAMS.map((s) => [s.id, s]));
const store = new Store(streams, cfg.snapshotPath);

/**
 * LIVE preflight: confirm the facilitator is reachable and within quota BEFORE mounting the
 * payment middleware. Without this, quota exhaustion (~300 calls/day, shared) makes the server
 * crash at init; a public demo must degrade gracefully instead.
 */
async function facilitatorReady(): Promise<boolean> {
  if (cfg.mode !== "live") return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${cfg.facilitatorUrl}/supported`, {
      headers: { Authorization: cfg.facilitatorApiKey },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(`   facilitator preflight: HTTP ${res.status}; starting degraded (no live settlement)`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`   facilitator preflight failed (${(err as Error).message}); starting degraded`);
    return false;
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
if (cfg.mode === "live" && process.env.SELF_FACILITATOR !== "0") {
  try {
    selfFacilitator = await createFacilitatorRouter(facilitatorOptionsFromEnv());
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode: cfg.mode, network: cfg.network, liveSettlement: cfg.mode !== "live" || liveReady });
});

app.get("/streams", (_req, res) => {
  res.json({ streams: STREAMS });
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
      const data = nextChunk(session.streamId, session.ticks);
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

// Public proof feed (machine-readable). The /impact.html page renders this live.
app.get("/impact", (_req, res) => {
  const t = store.totals();
  const snapshot: ImpactSnapshot = {
    network: cfg.network,
    mock: cfg.mode === "mock",
    totals: {
      settlements: t.settlements,
      totalPaid: t.totalPaid.toString(),
      asset: cfg.asset,
      activeSessions: store.activeSessionCount(),
      uniqueAgents: t.uniqueAgents,
      uniqueProviders: t.uniqueProviders,
      secondsStreamed: Math.round(t.secondsStreamed),
    },
    recent: store.recentEvents(50),
    decisions: store.recentDecisions(8),
  };
  res.json(snapshot);
});

// Judge-facing demo console: one click runs a real (or clearly-labelled simulated) agent session.
mountDemo(app, cfg, cfg.mode === "live" && liveReady);

app.use(express.static(join(__dirname, "..", "public")));

app.listen(cfg.port, () => {
  console.log(`\n💧 Sluice resource server`);
  console.log(`   mode:    ${cfg.mode.toUpperCase()}${cfg.mode === "mock" ? " (no creds needed)" : ""}`);
  console.log(`   network: ${cfg.network}`);
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
