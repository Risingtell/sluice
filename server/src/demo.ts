/**
 * Judge-facing live demo runner.
 *
 * POST /demo/run?stream=<id> streams (SSE) one complete autonomous agent session, run server-side
 * against this very server. In LIVE mode each tick is a REAL x402 settlement on casper-test, with
 * the tx hash pushed to the browser as it lands. The viewer watches the actual thing happen: 402
 * challenge, EIP-712 signature, facilitator settle, on-chain transfer, and the agent closing its
 * own gate with a stated reason.
 *
 * Protections for a public deployment:
 *   - one demo session at a time (409 while busy)
 *   - a daily budget of LIVE sessions (the facilitator allows ~300 calls/day); when spent, the
 *     demo runs the same meter + policy code with simulated settlement, clearly labelled
 *   - live child failures fall back to the simulation path instead of a dead page
 */

import type { Express, Request, Response } from "express";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StreamingMeter } from "./meter.ts";
import { MockSettlementProvider } from "./settlement.ts";
import { Store } from "./store.ts";
import { nextChunk } from "./feed.ts";
import { policyForStream } from "../../agent/src/policy.ts";
import { STREAMS, type ServerConfig } from "./config.ts";

const BUDGET_FILE = "server/.data/demo-budget.json";
const LIVE_SESSIONS_PER_DAY = parseInt(process.env.DEMO_LIVE_SESSIONS_PER_DAY || "8", 10);
const DEMO_TICK_MS = parseInt(process.env.DEMO_TICK_MS || "2000", 10);
const DEMO_MAX_TICKS = parseInt(process.env.DEMO_MAX_TICKS || "6", 10);
const DEMO_BUDGET_X402 = process.env.DEMO_BUDGET_X402 || "0.05";

interface DayBudget {
  day: string;
  liveSessions: number;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function readBudget(): DayBudget {
  try {
    const b = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as DayBudget;
    if (b.day === todayUTC()) return b;
  } catch {}
  return { day: todayUTC(), liveSessions: 0 };
}

function writeBudget(b: DayBudget): void {
  try {
    mkdirSync(dirname(BUDGET_FILE), { recursive: true });
    writeFileSync(BUDGET_FILE, JSON.stringify(b));
  } catch {}
}

export function demoBudgetLeft(): number {
  return Math.max(0, LIVE_SESSIONS_PER_DAY - readBudget().liveSessions);
}

/** Strip terminal glyphs from agent CLI output so the web console stays clean. */
function cleanLine(line: string): string {
  return line
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}⭐⁉️]/gu, "")
    .replace(/^\s*[|·]\s*$/, "")
    .trimEnd();
}

type Send = (event: string, data: unknown) => void;

/** Run the REAL agent (child process, same code as `npm run agent`) and relay its output. */
function runLiveChild(streamId: string, port: number, send: Send): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "agent/src/index.ts"],
      {
        env: {
          ...process.env,
          MODE: "live",
          SERVER_URL: `http://localhost:${port}`,
          AGENT_STREAM: streamId,
          AGENT_TICK_MS: String(DEMO_TICK_MS),
          AGENT_MAX_TICKS: String(DEMO_MAX_TICKS),
          AGENT_BUDGET_X402: DEMO_BUDGET_X402,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const line = cleanLine(raw);
        if (!line.trim()) continue;
        // Enrich tick lines with the full explorer link for the UI.
        const tx = /https:\/\/testnet\.cspr\.live\/deploy\/([0-9a-f]{64})/.exec(raw);
        if (tx) send("tick", { line, txHash: tx[1], explorerUrl: tx[0] });
        else if (/gate|closed|objective|budget|watching|warming|signal|job/i.test(line) && /^\s/.test(raw)) send("log", { line });
        else send("log", { line });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    // A live session should never take more than ~4 minutes; kill runaways.
    const killer = setTimeout(() => child.kill(), 240_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve(code ?? 1);
    });
    child.on("error", () => {
      clearTimeout(killer);
      resolve(1);
    });
  });
}

/**
 * Simulation path: the SAME StreamingMeter + agent policy code, with settlement simulated.
 * Uses its own store/snapshot so simulated events never touch the on-chain proof data.
 */
async function runSimulated(streamId: string, simMeter: StreamingMeter, send: Send): Promise<void> {
  const provider = new MockSettlementProvider(120);
  const { policy } = policyForStream(streamId, Number(DEMO_BUDGET_X402));
  const budgetMotes = BigInt(Math.round(Number(DEMO_BUDGET_X402) * 1e9));
  const spec = STREAMS.find((s) => s.id === streamId)!;

  const session = simMeter.openSession(streamId, "demo-agent-sim", {
    policy: policy.name,
    objective: policy.objective,
  });
  send("log", { line: `session ${session.id} opened (simulation)` });
  send("log", { line: `policy "${policy.name}" | objective: ${policy.objective} | budget ${DEMO_BUDGET_X402} X402` });

  let closeReason = `reached ${DEMO_MAX_TICKS}-tick cap`;
  let spent = 0n;
  for (let tick = 1; tick <= DEMO_MAX_TICKS; tick++) {
    await new Promise((r) => setTimeout(r, Math.min(DEMO_TICK_MS, 1200)));
    const quote = simMeter.quoteTick(session.id);
    const result = await provider.settle(quote);
    const { session: s } = simMeter.commitTick(quote, result);
    spent = BigInt(s.totalPaid);
    const data = nextChunk(streamId, s.ticks);
    send("tick", {
      line: `tick ${tick} | paid ${(Number(quote.amount) / 1e9).toFixed(6)} X402 | total ${(Number(spent) / 1e9).toFixed(6)} | simulated settlement`,
      simulated: true,
    });
    send("log", { line: `data: ${JSON.stringify(data)}` });
    const nextTickMotes = BigInt(quote.amount || "1");
    const decision = policy.decide(data, { tick, spentMotes: spent, nextTickMotes, budgetMotes });
    send("log", { line: `decision: ${decision.reason}` });
    if (!decision.keepStreaming) {
      closeReason = decision.reason;
      break;
    }
  }
  simMeter.closeSession(session.id, closeReason);
  send("log", { line: `gate closed: ${closeReason}` });
  send("log", { line: `${spec.title}: simulation complete. The settlement history on this page is still the real on-chain record.` });
}

export function mountDemo(app: Express, cfg: ServerConfig, liveReady: boolean): void {
  // Dedicated store for simulated demo runs: never mixes with the on-chain proof data.
  const simStore = new Store(new Map(STREAMS.map((s) => [s.id, s])), "server/.data/impact.sim.json");
  const simMeter = new StreamingMeter(simStore, { payTo: "demo-sim", maxTickSeconds: cfg.maxTickSeconds });

  let busy = false;

  app.get("/demo/status", (_req, res) => {
    res.json({
      liveReady,
      busy,
      liveSessionsLeftToday: liveReady ? demoBudgetLeft() : 0,
      streams: STREAMS.map((s) => ({ id: s.id, title: s.title, provider: s.provider, ratePerSecond: s.ratePerSecond })),
    });
  });

  app.post("/demo/run", async (req: Request, res: Response) => {
    const streamId = String(req.query.stream || "btc-usd");
    if (!STREAMS.some((s) => s.id === streamId)) {
      return res.status(400).json({ error: "unknown stream" });
    }
    if (busy) {
      return res.status(409).json({ error: "a demo session is already running; try again in a minute" });
    }
    busy = true;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send: Send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(": hb\n\n"), 15_000);

    try {
      const budget = readBudget();
      const canLive = liveReady && budget.liveSessions < LIVE_SESSIONS_PER_DAY;
      if (canLive) {
        writeBudget({ day: budget.day, liveSessions: budget.liveSessions + 1 });
        send("mode", { live: true, note: "real on-chain settlement on casper:casper-test" });
        const code = await runLiveChild(streamId, cfg.port, send);
        if (code !== 0) {
          send("mode", {
            live: false,
            note: "live settlement unavailable right now (daily facilitator quota is shared); continuing in simulation",
          });
          await runSimulated(streamId, simMeter, send);
        }
      } else {
        send("mode", {
          live: false,
          note: liveReady
            ? "today's live on-chain demo budget is spent; running the same meter + policy code with simulated settlement"
            : "facilitator unavailable; running the same meter + policy code with simulated settlement",
        });
        await runSimulated(streamId, simMeter, send);
      }
      send("done", { ok: true });
    } catch (err) {
      send("error", { message: (err as Error).message });
    } finally {
      clearInterval(heartbeat);
      busy = false;
      res.end();
    }
  });
}

/** Seed the durable proof snapshot from the committed real history on first boot (fresh hosts). */
export function seedSnapshot(snapshotPath: string): void {
  const seed = "data/impact.seed.json";
  if (!existsSync(snapshotPath) && existsSync(seed)) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, readFileSync(seed));
    console.log(`   seeded proof snapshot from ${seed}`);
  }
}
