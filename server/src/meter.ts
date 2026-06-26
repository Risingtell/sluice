/**
 * StreamingMeter — the core Sluice primitive.
 *
 * x402 is a per-request protocol; streaming is modelled as a pull loop where each tick settles
 * for the wall-clock time the agent held the stream since its last paid tick. Pay the tick → get
 * the next chunk. Skip/refuse a tick → the next chunk never comes (the "sluice gate" shuts). Every
 * successful tick is one real (or, in MOCK mode, simulated) on-chain settlement.
 *
 * Billing is split into two phases so the same core serves both paths:
 *   - quoteTick():  pure computation of what this tick owes (no mutation). In LIVE mode this feeds
 *                   the x402 DynamicPrice function BEFORE the facilitator settles.
 *   - commitTick(): records the settlement + advances the session AFTER it has been paid (in LIVE
 *                   mode, from the AfterSettleHook with the real on-chain tx hash).
 */

import { randomUUID } from "node:crypto";
import type { Session, SettlementEvent, StreamSpec } from "../../shared/types.ts";

export interface MeterConfig {
  payTo: string;
  /** Hard cap on seconds billed in a single tick (guards against clock jumps / long sleeps). */
  maxTickSeconds: number;
}

/** A computed-but-not-yet-settled charge for one tick. */
export interface TickQuote {
  session: Session;
  stream: StreamSpec;
  /** Wall-clock instant the quote was taken; commit bills exactly up to here. */
  at: number;
  elapsedMs: number;
  seconds: number;
  /** Motes owed for this tick, as a decimal string. */
  amount: string;
}

/** The outcome of paying a tick — synthetic in MOCK mode, a real CEP-18 transfer when live. */
export interface SettlementResult {
  txHash: string;
  explorerUrl: string;
  network: string;
}

export class StreamingMeter {
  constructor(
    private readonly store: { streams: Map<string, StreamSpec> } & {
      getSession(id: string): Session | undefined;
      putSession(s: Session): void;
      addEvent(e: SettlementEvent): void;
    },
    private readonly cfg: MeterConfig,
  ) {}

  openSession(streamId: string, agent: string, opts: { policy?: string; objective?: string } = {}): Session {
    const stream = this.requireStream(streamId);
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      streamId: stream.id,
      agent,
      status: "active",
      startedAt: now,
      settledMs: 0,
      totalPaid: "0",
      ticks: 0,
      lastSettledAt: now,
      policy: opts.policy,
      objective: opts.objective,
    };
    this.store.putSession(session);
    return session;
  }

  /** Compute what the next tick owes, without mutating anything. Throws if the session can't tick. */
  quoteTick(sessionId: string): TickQuote {
    const session = this.store.getSession(sessionId);
    if (!session) throw new MeterError(404, "unknown session");
    if (session.status !== "active") throw new MeterError(409, `session is ${session.status}`);

    const stream = this.requireStream(session.streamId);
    const at = Date.now();
    const elapsedMs = Math.min(at - session.lastSettledAt, this.cfg.maxTickSeconds * 1000);
    const amount = (BigInt(stream.ratePerSecond) * BigInt(elapsedMs)) / 1000n;
    return { session, stream, at, elapsedMs, seconds: elapsedMs / 1000, amount: amount.toString() };
  }

  /** Record a paid tick: append the settlement event and advance the session up to quote.at. */
  commitTick(quote: TickQuote, result: SettlementResult): { session: Session; event: SettlementEvent } {
    const session = this.store.getSession(quote.session.id);
    if (!session) throw new MeterError(404, "unknown session");

    const event: SettlementEvent = {
      id: randomUUID(),
      sessionId: session.id,
      streamId: session.streamId,
      agent: session.agent,
      payTo: quote.stream.payTo ?? this.cfg.payTo,
      provider: quote.stream.provider,
      amount: quote.amount,
      asset: quote.stream.asset,
      seconds: quote.seconds,
      network: result.network,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      settledAt: quote.at,
    };
    this.store.addEvent(event);

    session.lastSettledAt = quote.at;
    session.settledMs += quote.elapsedMs;
    session.ticks += 1;
    session.totalPaid = (BigInt(session.totalPaid) + BigInt(quote.amount)).toString();
    this.store.putSession(session);

    return { session, event };
  }

  /** The stream a session is consuming (used to resolve the provider payee per tick). */
  streamOf(sessionId: string | undefined): StreamSpec | undefined {
    if (!sessionId) return undefined;
    const session = this.store.getSession(sessionId);
    return session ? this.store.streams.get(session.streamId) : undefined;
  }

  halt(sessionId: string, reason: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    session.status = "halted";
    session.haltedReason = reason;
    this.store.putSession(session);
  }

  closeSession(sessionId: string, reason?: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new MeterError(404, "unknown session");
    if (session.status === "active") {
      session.status = "closed";
      if (reason) session.closedReason = reason;
      session.closedAt = Date.now();
      this.store.putSession(session);
    }
    return session;
  }

  private requireStream(streamId: string): StreamSpec {
    const stream = this.store.streams.get(streamId);
    if (!stream) throw new MeterError(404, `unknown stream: ${streamId}`);
    return stream;
  }
}

export class MeterError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
