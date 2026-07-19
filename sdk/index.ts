/**
 * @sluice/x402 - client SDK for the Sluice streaming meter.
 *
 * Rent a continuously-metered resource and pay for it per second via Casper x402, from your own
 * agent, in a few lines:
 *
 *   import { Sluice } from "./sdk/index.ts";
 *
 *   const sluice = await Sluice.connect({ serverUrl: "http://localhost:4021" });          // mock
 *   // const sluice = await Sluice.connect({ mode: "live", keyPath: "keys/agent.pem" }); // live
 *
 *   const summary = await sluice.stream("btc-usd", {
 *     budgetX402: 0.05,
 *     decide: (chunk, ctx) => ({
 *       keepStreaming: ctx.tick < 5,
 *       reason: `price ${chunk.price}`,
 *     }),
 *   });
 *
 * In LIVE mode every tick signs an EIP-712 `transfer_with_authorization` over the CEP-18 token
 * and the hosted Casper x402 facilitator settles it on-chain (the facilitator pays the gas). In
 * MOCK mode the same loop runs with simulated settlement. The decide() callback is the agency:
 * return keepStreaming=false and the sluice gate closes, ending payment instantly.
 */

import type { ImpactSnapshot, Session, SettlementEvent, StreamSpec } from "../shared/types.ts";

export interface SluiceConnectOptions {
  /** Sluice resource server. Default http://localhost:4021. */
  serverUrl?: string;
  /** "mock" (default; no credentials) or "live" (real Casper x402 settlement). */
  mode?: "mock" | "live";
  /** LIVE only: path to the agent's PEM-encoded Casper private key. */
  keyPath?: string;
  /** LIVE only: key algorithm. Default ed25519. */
  keyAlgo?: "ed25519" | "secp256k1";
}

export interface DecisionContext {
  /** 1-based count of paid ticks so far. */
  tick: number;
  /** Motes spent on this session so far. */
  spentMotes: bigint;
  /** Expected cost of the next tick, in motes. */
  nextTickMotes: bigint;
  /** Session budget in motes. */
  budgetMotes: bigint;
}

export interface Decision {
  keepStreaming: boolean;
  reason: string;
}

/** Your agent's per-tick policy: look at the freshly-paid-for chunk and decide to keep paying or stop. */
export type Decide = (chunk: any, ctx: DecisionContext) => Decision;

export interface StreamOptions {
  /** Spend ceiling for the session, in X402 (default 0.05). The SDK never breaches it. */
  budgetX402?: number;
  /** Hard tick cap (default 10) as a safety net under the policy. */
  maxTicks?: number;
  /** Delay between ticks in ms (default 2000; keep >= 1500 for testnet finality). */
  tickMs?: number;
  /** The agent's policy. Default: stream until maxTicks. */
  decide?: Decide;
  /** Called after every paid tick with the fresh chunk and settlement info. */
  onTick?: (info: { tick: number; data: any; txHash: string; session: Session }) => void;
}

export interface StreamSummary {
  session: Session;
  ticks: number;
  totalPaidMotes: bigint;
  closeReason: string;
  /** Tx hashes of every on-chain settlement in this session (empty in mock mode). */
  txHashes: string[];
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class Sluice {
  private constructor(
    private readonly serverUrl: string,
    private readonly tickFetch: FetchLike,
    private readonly readTx: (r: Response) => string,
    /** The agent's on-chain address (or a generated mock id). */
    public readonly agentId: string,
  ) {}

  static async connect(opts: SluiceConnectOptions = {}): Promise<Sluice> {
    const serverUrl = (opts.serverUrl || "http://localhost:4021").replace(/\/$/, "");
    if (opts.mode !== "live") {
      const id = `sdk-${Math.random().toString(16).slice(2, 8)}`;
      return new Sluice(serverUrl, fetch, () => "", id);
    }
    if (!opts.keyPath) throw new Error("live mode needs keyPath (PEM Casper private key)");
    const { x402Client, x402HTTPClient, wrapFetchWithPayment } = await import("@x402/fetch");
    const { createClientCasperSigner } = await import("@make-software/casper-x402");
    const { ExactCasperScheme } = await import("@make-software/casper-x402/exact/client");
    const casperMod = await import("casper-js-sdk");
    const casperSdk = (casperMod as any).default ?? casperMod;
    const algo = opts.keyAlgo === "secp256k1" ? casperSdk.KeyAlgorithm.SECP256K1 : casperSdk.KeyAlgorithm.ED25519;
    const signer = await createClientCasperSigner(opts.keyPath, algo);
    const selector = (_v: number, options: any[]) => options.find((o) => o.network.startsWith("casper:")) ?? options[0];
    const client = new x402Client(selector).register("casper:*", new ExactCasperScheme(signer));
    const httpClient = new x402HTTPClient(client);
    const tickFetch = wrapFetchWithPayment(fetch, client) as FetchLike;
    const readTx = (r: Response) =>
      httpClient.getPaymentSettleResponse((n: string) => r.headers.get(n))?.transaction ?? "";
    return new Sluice(serverUrl, tickFetch, readTx, signer.accountAddress());
  }

  /** The catalogue of metered streams the server offers. */
  async listStreams(): Promise<StreamSpec[]> {
    const res = await fetch(`${this.serverUrl}/streams`);
    if (!res.ok) throw new Error(`GET /streams -> ${res.status}`);
    return ((await res.json()) as { streams: StreamSpec[] }).streams;
  }

  /** Open a metered session (free; only ticking costs). */
  async open(streamId: string, meta: { policy?: string; objective?: string } = {}): Promise<Session> {
    const res = await this.post(`/sessions`, { streamId, agent: this.agentId, ...meta });
    return res.session as Session;
  }

  /**
   * Pay for one tick and receive the next chunk. In LIVE mode this performs the full x402
   * exchange: 402 challenge -> EIP-712 signature -> facilitator settle -> real on-chain transfer.
   */
  async payTick(sessionId: string): Promise<{ session: Session; data: any; txHash: string }> {
    const res = await this.tickFetch(`${this.serverUrl}/tick?session=${sessionId}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`tick unpaid (${res.status}): ${body.slice(0, 140)}`);
    }
    const body = (await res.json()) as { session: Session; settlement?: SettlementEvent; data: any };
    const txHash = this.readTx(res) || body.settlement?.txHash || "";
    return { session: body.session, data: body.data, txHash };
  }

  /** Close the gate. */
  async close(sessionId: string, reason?: string): Promise<Session> {
    const res = await this.post(`/sessions/${sessionId}/close`, { reason });
    return res.session as Session;
  }

  /** The public proof feed (cumulative totals + recent on-chain settlements). */
  async impact(): Promise<ImpactSnapshot> {
    const res = await fetch(`${this.serverUrl}/impact`);
    if (!res.ok) throw new Error(`GET /impact -> ${res.status}`);
    return (await res.json()) as ImpactSnapshot;
  }

  /**
   * The full autonomous loop: open, pay tick-by-tick while your decide() says the stream is
   * still worth it (never breaching the budget), then close the gate with the reason.
   */
  async stream(streamId: string, opts: StreamOptions = {}): Promise<StreamSummary> {
    const budgetX402 = opts.budgetX402 ?? 0.05;
    const maxTicks = opts.maxTicks ?? 10;
    const tickMs = opts.tickMs ?? 2000;
    const decide: Decide = opts.decide ?? ((_c, ctx) => ({ keepStreaming: ctx.tick < maxTicks, reason: "streaming" }));

    const spec = (await this.listStreams()).find((s) => s.id === streamId);
    if (!spec) throw new Error(`stream ${streamId} not offered`);
    const budgetMotes = BigInt(Math.round(budgetX402 * 1e9));

    const session = await this.open(streamId);
    const txHashes: string[] = [];
    let ticks = 0;
    let totalPaid = 0n;
    let prevPaid = 0n;
    let closeReason = `reached ${maxTicks}-tick cap`;

    while (ticks < maxTicks) {
      await new Promise((r) => setTimeout(r, tickMs));
      ticks++;
      let data: any;
      let current: Session;
      try {
        const t = await this.payTick(session.id);
        data = t.data;
        current = t.session;
        totalPaid = BigInt(current.totalPaid);
        if (t.txHash) txHashes.push(t.txHash);
        opts.onTick?.({ tick: ticks, data, txHash: t.txHash, session: current });
      } catch (err) {
        closeReason = `stream interrupted (${(err as Error).message.slice(0, 80)})`;
        break;
      }
      const lastCost = totalPaid - prevPaid;
      prevPaid = totalPaid;
      const nextTickMotes = lastCost > 0n ? lastCost : BigInt(spec.ratePerSecond) * BigInt(Math.ceil(tickMs / 1000));
      if (totalPaid + nextTickMotes > budgetMotes) {
        closeReason = `budget ${budgetX402} X402 reached`;
        break;
      }
      const decision = decide(data, { tick: ticks, spentMotes: totalPaid, nextTickMotes, budgetMotes });
      if (!decision.keepStreaming) {
        closeReason = decision.reason;
        break;
      }
    }

    const closed = await this.close(session.id, closeReason);
    return { session: closed, ticks, totalPaidMotes: totalPaid, closeReason, txHashes };
  }

  private async post(path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`POST ${path} -> ${res.status}: ${err.error || res.statusText}`);
    }
    return res.json();
  }
}
