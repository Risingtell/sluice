/**
 * sluice-x402 - client SDK for the Sluice streaming meter.
 *
 * Rent a continuously-metered resource and pay for it per second via Casper x402, from your own
 * agent, in a few lines:
 *
 *   import { Sluice } from "sluice-x402";
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
 * In LIVE mode every tick signs an EIP-712 `transfer_with_authorization` over the CEP-18 token.
 * Who submits it, and so who pays the gas, depends on what the server offers on that network: the
 * server's facilitator ("exact", the server pays) or this agent itself ("buyer-settle", the agent
 * pays, about 3.3 CSPR per tick). `payGas` chooses. In MOCK mode the same loop runs with simulated
 * settlement. The decide() callback is the agency:
 * return keepStreaming=false and the sluice gate closes, ending payment instantly.
 */

import type { ImpactSnapshot, Session, SettlementEvent, StreamSpec } from "../shared/types.ts";
import { explorerTxUrl, networkSelector } from "../shared/networks.ts";
import { SCHEME_BUYER_SETTLE } from "../shared/buyer-settle.ts";
import { BuyerSettleClientScheme, GasTracker } from "./buyer-settle.ts";
import { unwrapCspr, wrapCspr, type WrapResult } from "./wrap.ts";

export { WCSPR_MAINNET, WCSPR_TESTNET } from "../shared/tokens.ts";
export type { WrapResult } from "./wrap.ts";

/** The hosted Sluice server: real providers, real on-chain settlement on Casper testnet. Pass it as serverUrl. */
export const HOSTED_SERVER = "https://sluice-kff3.onrender.com";

export interface SluiceConnectOptions {
  /** Sluice resource server. Default http://localhost:4021; HOSTED_SERVER for the hosted one. */
  serverUrl?: string;
  /** "mock" (default; no credentials) or "live" (real Casper x402 settlement). */
  mode?: "mock" | "live";
  /**
   * LIVE only: the network to pay on, "casper:casper" (mainnet) or "casper:casper-test". Unset, the
   * SDK pays with the server's first Casper offer (testnet on the hosted server). When set, it pays
   * only on that network and refuses a server that does not offer it.
   */
  network?: string;
  /** LIVE only: path to the agent's PEM-encoded Casper private key. */
  keyPath?: string;
  /** LIVE only: key algorithm. Default ed25519. */
  keyAlgo?: "ed25519" | "secp256k1";
  /**
   * LIVE only: who pays the gas for each tick's transfer.
   *   - unset (default): the server where it offers to, otherwise this agent. With no `network`
   *     named, a server-paid offer on any network beats paying gas yourself, so an agent never
   *     starts spending its own CSPR on mainnet just because a server listed mainnet first.
   *   - true: always this agent ("buyer-settle"). It submits each transfer from its own account,
   *     about 3.3 CSPR per tick, and refuses a server that does not offer this.
   *   - false: only the server ("exact"); refuses a server that wants the buyer to pay.
   * Mainnet Sluice servers do not pay gas for buyers, so paying on mainnet means payGas true or unset.
   */
  payGas?: boolean;
  /** LIVE + buyer-settle: gas limit per transfer, in motes (default 5 CSPR; about 3.3 is used). */
  gasLimitMotes?: number;
  /** LIVE + buyer-settle: Casper node to submit to, per network (default the public node). */
  rpcUrls?: Record<string, string>;
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
  /**
   * Pause before each tick, in ms (default 2000). This is a floor, not the tick rate: in LIVE mode
   * every tick also waits for its own on-chain settlement (measured 4-11 s, about 7 s median, on
   * Casper testnet), so ticks land roughly every settlement time + tickMs, and that, not one
   * second, is the billing resolution in LIVE mode. Each tick bills the real time since the
   * previous one, so time spent settling is billed once, in the next tick, never twice. The server
   * caps a single tick (MAX_TICK_SECONDS, 10 s by default); time past the cap is not billed, in the
   * buyer's favour. Watch it with onTick's settleMs and the summary's settlement stats.
   */
  tickMs?: number;
  /** The agent's policy. Default: stream until maxTicks. */
  decide?: Decide;
  /** Called after every paid tick with the fresh chunk and settlement info. */
  onTick?: (info: TickInfo) => void;
  /**
   * Gas ceiling for the session in CSPR, when this agent pays its own gas (buyer-settle). The SDK
   * stops before a tick whose gas could cross it: until it has paid one tick it assumes the full
   * gas limit (5 CSPR by default), after that the last tick's cost. Counts every transfer this
   * agent submitted, including ones refused or failed. Unset: no gas ceiling beyond maxTicks.
   */
  gasBudgetCSPR?: number;
}

export interface TickInfo {
  tick: number;
  data: any;
  /** The settlement's Casper 2.0 Version1 transaction hash (a synthetic hash in mock mode). */
  transactionHash: string;
  /** Same as transactionHash (older name, kept for existing code). */
  txHash: string;
  /**
   * Wall time of the paid request, ms: the 402 challenge, signing, the data chunk and, in LIVE
   * mode, the on-chain settlement, which is most of it.
   */
  settleMs: number;
  /** Seconds of streaming this tick billed (time since the previous tick, server-capped). */
  billedSeconds: number;
  /** Gas this agent paid for the tick's transfer, in motes; 0 when the server paid it. */
  gasMotes: bigint;
  session: Session;
}

export interface SettlementTiming {
  minMs: number;
  medianMs: number;
  maxMs: number;
}

export interface StreamSummary {
  session: Session;
  ticks: number;
  totalPaidMotes: bigint;
  closeReason: string;
  /** Version1 transaction hashes of every settlement in this session (synthetic in mock mode). */
  transactionHashes: string[];
  /** Same as transactionHashes (older name, kept for existing code). */
  txHashes: string[];
  /** How long each paid tick took, end to end (settleMs). LIVE mode only; null in mock mode or with no paid tick. */
  settlement: SettlementTiming | null;
  /**
   * Gas this agent paid across the session, in motes: every transfer it submitted, including any a
   * server refused or that failed on chain. 0 when the server paid every tick.
   */
  gasPaidMotes: bigint;
}

export interface PaidTick {
  session: Session;
  data: any;
  /** Casper 2.0 Version1 transaction hash: query it with info_get_transaction {"Version1": hash}. */
  transactionHash: string;
  /** Same as transactionHash (older name, kept for existing code). */
  txHash: string;
  network: string;
  /** cspr.live /transaction/ link for a real settlement, "" otherwise. */
  explorerUrl: string;
  /** Wall time of the paid request, ms (challenge, signing, chunk and, in LIVE mode, settlement). */
  settleMs: number;
  /** Gas this agent paid for this tick's transfer, in motes; 0 when the server paid it. */
  gasMotes: bigint;
}

/** min / median / max of a list of durations (null for an empty list). */
export function timing(ms: number[]): SettlementTiming | null {
  if (!ms.length) return null;
  const s = [...ms].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return { minMs: s[0], medianMs: median, maxMs: s[s.length - 1] };
}

/**
 * Which payment offer to take, among those this agent can pay (schemes it registered). A
 * server-paid "exact" offer beats paying gas yourself: on the named network, or, with no network
 * named, on any Casper network. Otherwise the network rule of networkSelector applies.
 */
export function chooseOffer<T extends { network: string; scheme: string }>(version: number, options: T[], network?: string): T {
  const serverPaid = network ? undefined : options.find((o) => o.network.startsWith("casper:") && o.scheme === "exact");
  const picked = serverPaid ?? (networkSelector(network)(version, options) as T);
  return options.find((o) => o.network === picked.network && o.scheme === "exact") ?? picked;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** CSPR (9 decimals) to motes, exactly: 1.5 -> 1500000000n. */
function toMotes(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`amount must be a positive number of CSPR, got ${amount}`);
  const [whole, frac = ""] = amount.toFixed(9).split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
}

type ReadSettlement = (r: Response) => { tx: string; network: string };

export class Sluice {
  private constructor(
    private readonly serverUrl: string,
    private readonly tickFetch: FetchLike,
    private readonly readTx: ReadSettlement,
    /** The agent's on-chain address (or a generated mock id). */
    public readonly agentId: string,
    /** True when ticks settle on chain (LIVE mode). */
    private readonly live: boolean = false,
    /** Gas this agent spends on transfers it submits itself (buyer-settle). */
    private readonly gas: GasTracker = new GasTracker(),
    /** Worst-case gas for one self-paid tick, in motes; 0 when this agent never pays gas. */
    private readonly gasPerTickCeiling: bigint = 0n,
    /** LIVE: the agent's key, for wrapping and unwrapping CSPR. */
    private readonly wallet?: { casperSdk: any; privateKey: any; rpcUrls?: Record<string, string> },
  ) {}

  static async connect(opts: SluiceConnectOptions = {}): Promise<Sluice> {
    // A server is always named on purpose: live payments never go to the hosted server, or to
    // mainnet, without the caller asking. Pass serverUrl: HOSTED_SERVER to use it.
    const serverUrl = (opts.serverUrl || "http://localhost:4021").replace(/\/$/, "");
    if (opts.mode !== "live") {
      const id = `sdk-${Math.random().toString(16).slice(2, 8)}`;
      return new Sluice(serverUrl, fetch, () => ({ tx: "", network: "" }), id);
    }
    if (!opts.keyPath) throw new Error("live mode needs keyPath (PEM Casper private key)");
    const { x402Client, x402HTTPClient, wrapFetchWithPayment } = await import("@x402/fetch");
    const { createClientCasperSigner } = await import("@make-software/casper-x402");
    const { ExactCasperScheme } = await import("@make-software/casper-x402/exact/client");
    const casperMod = await import("casper-js-sdk");
    const casperSdk = (casperMod as any).default ?? casperMod;
    const algo = opts.keyAlgo === "secp256k1" ? casperSdk.KeyAlgorithm.SECP256K1 : casperSdk.KeyAlgorithm.ED25519;
    const signer = await createClientCasperSigner(opts.keyPath, algo);
    // Remember which offer was paid, so a receipt without a network still links the right explorer.
    let chosen = opts.network ?? "";
    // Only the schemes this agent agreed to are registered, so the x402 client never offers the
    // selector anything else. A server-paid offer wins over paying gas: on the named network, or,
    // with no network named, on any network (an agent that did not ask for mainnet must not start
    // paying mainnet gas because a server lists mainnet first).
    const selector = (version: number, options: { network: string; scheme: string }[]) => {
      const best = chooseOffer(version, options, opts.network);
      chosen = best.network;
      return best;
    };
    const client = new x402Client(selector as never);
    if (opts.payGas !== true) client.register("casper:*", new ExactCasperScheme(signer));
    const gas = new GasTracker();
    const { readFile } = await import("node:fs/promises");
    const privateKey = casperSdk.PrivateKey.fromPem(await readFile(opts.keyPath, "utf8"), algo);
    if (opts.payGas !== false) {
      const eip712 = await import("@casper-ecosystem/casper-eip-712");
      client.register("casper:*", new BuyerSettleClientScheme(casperSdk, privateKey, eip712 as never, gas, { gasLimitMotes: opts.gasLimitMotes, rpcUrls: opts.rpcUrls }) as never);
    }
    const httpClient = new x402HTTPClient(client);
    const tickFetch = wrapFetchWithPayment(fetch, client) as FetchLike;
    const readTx: ReadSettlement = (r) => {
      const settled = httpClient.getPaymentSettleResponse((n: string) => r.headers.get(n));
      return { tx: settled?.transaction ?? "", network: String(settled?.network || chosen) };
    };
    const ceiling = opts.payGas === false ? 0n : BigInt(opts.gasLimitMotes ?? 5_000_000_000);
    return new Sluice(serverUrl, tickFetch, readTx, signer.accountAddress(), true, gas, ceiling, { casperSdk, privateKey, rpcUrls: opts.rpcUrls });
  }

  /**
   * LIVE: wrap CSPR from this agent's account into WCSPR (1:1), the token mainnet Sluice servers are
   * paid in. Customers buy CSPR (Casper Wallet's Buy, cspr.live, or an exchange) and wrap it here.
   * The network is always named: wrapping spends the account's own CSPR, about 3.2 CSPR of gas each.
   */
  async wrapCspr(amountCSPR: number, network: string, opts: { gasLimitMotes?: number; rpcUrl?: string } = {}): Promise<WrapResult> {
    if (!this.wallet) throw new Error("wrapCspr needs live mode (a key)");
    const rpcUrl = opts.rpcUrl || this.wallet.rpcUrls?.[network];
    return wrapCspr(this.wallet.casperSdk, this.wallet.privateKey, toMotes(amountCSPR), { network, ...opts, rpcUrl });
  }

  /** LIVE: unwrap WCSPR back into CSPR in this agent's account (about 3.5 CSPR of gas). */
  async unwrapCspr(amountWCSPR: number, network: string, opts: { gasLimitMotes?: number; rpcUrl?: string } = {}): Promise<WrapResult> {
    if (!this.wallet) throw new Error("unwrapCspr needs live mode (a key)");
    const rpcUrl = opts.rpcUrl || this.wallet.rpcUrls?.[network];
    return unwrapCspr(this.wallet.casperSdk, this.wallet.privateKey, toMotes(amountWCSPR), { network, ...opts, rpcUrl });
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
  async payTick(sessionId: string): Promise<PaidTick> {
    const started = Date.now();
    this.gas.begin();
    const res = await this.tickFetch(`${this.serverUrl}/tick?session=${sessionId}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text();
      // A buyer-settled transfer is already on chain by the time the server answers. Say so, with
      // the hash, so a refused tick is never mistaken for money that did not move.
      const sent = this.gas.submitted;
      const note = sent.length ? ` Your transfer ${sent.join(", ")} executed on chain, but the server did not accept it.` : "";
      throw new Error(`tick unpaid (${res.status}): ${body.slice(0, 140)}${note}`);
    }
    const body = (await res.json()) as { session: Session; settlement?: SettlementEvent; data: any };
    const settled = this.readTx(res);
    const txHash = settled.tx || body.settlement?.txHash || "";
    const network = settled.network || body.settlement?.network || "";
    // An explorer link only for a real chain settlement whose network is known.
    const explorerUrl = network.startsWith("casper:") ? explorerTxUrl(network, txHash) : "";
    const settleMs = Date.now() - started;
    const gasMotes = this.gas.take(txHash);
    return { session: body.session, data: body.data, transactionHash: txHash, txHash, network, explorerUrl, settleMs, gasMotes };
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
    const decide: Decide =
      opts.decide ??
      ((_c, ctx) => ({ keepStreaming: ctx.tick < maxTicks, reason: ctx.tick < maxTicks ? "streaming" : `reached ${maxTicks}-tick cap` }));

    const spec = (await this.listStreams()).find((s) => s.id === streamId);
    if (!spec) throw new Error(`stream ${streamId} not offered`);
    const budgetMotes = BigInt(Math.round(budgetX402 * 1e9));

    const session = await this.open(streamId);
    const txHashes: string[] = [];
    const settleTimes: number[] = [];
    let settledMsBefore = session.settledMs ?? 0;
    let ticks = 0;
    let totalPaid = 0n;
    let prevPaid = 0n;
    const gasAtStart = this.gas.total;
    let lastGas = 0n;
    const gasBudgetMotes = opts.gasBudgetCSPR === undefined ? undefined : BigInt(Math.round(opts.gasBudgetCSPR * 1e9));
    let closeReason = `reached ${maxTicks}-tick cap`;

    while (ticks < maxTicks) {
      // Before paying: could this tick's gas cross the ceiling? Until one self-paid tick has been
      // seen, assume the full gas limit.
      if (gasBudgetMotes !== undefined && this.gasPerTickCeiling > 0n) {
        const spent = this.gas.total - gasAtStart;
        const next = lastGas > 0n ? lastGas : this.gasPerTickCeiling;
        if (spent + next > gasBudgetMotes) {
          closeReason = `gas budget ${opts.gasBudgetCSPR} CSPR reached`;
          break;
        }
      }
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
        settleTimes.push(t.settleMs);
        if (t.gasMotes > 0n) lastGas = t.gasMotes;
        const billedSeconds = Math.max(0, ((current.settledMs ?? 0) - settledMsBefore) / 1000);
        settledMsBefore = current.settledMs ?? settledMsBefore;
        opts.onTick?.({ tick: ticks, data, transactionHash: t.txHash, txHash: t.txHash, settleMs: t.settleMs, billedSeconds, gasMotes: t.gasMotes, session: current });
      } catch (err) {
        // The full message (it may name a transfer that moved tokens) stays in the summary.
        closeReason = `stream interrupted (${(err as Error).message})`;
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

    const closed = await this.close(session.id, closeReason.slice(0, 200));
    return {
      session: closed,
      ticks,
      totalPaidMotes: totalPaid,
      closeReason,
      transactionHashes: txHashes,
      txHashes: [...txHashes],
      settlement: this.live ? timing(settleTimes) : null,
      gasPaidMotes: this.gas.total - gasAtStart,
    };
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
