/**
 * StreamingMeter — the core Sluice primitive.
 *
 * x402 is a per-request protocol; streaming is modelled as a pull loop where each tick settles
 * for the wall-clock time the agent held the stream since its last paid tick. Pay the tick → get
 * the next chunk. Skip/refuse a tick → the next chunk never comes (the "sluice gate" shuts). Every
 * successful tick is one real (or, in MOCK mode, simulated) on-chain settlement.
 */

import { randomUUID } from "node:crypto";
import type { Session, SettlementEvent, StreamSpec } from "../../shared/types.ts";
import type { SettlementProvider, TickContext } from "./settlement.ts";
import type { Store } from "./store.ts";

export interface MeterConfig {
  payTo: string;
  /** Hard cap on seconds billed in a single tick (guards against clock jumps / long sleeps). */
  maxTickSeconds: number;
}

export class StreamingMeter {
  constructor(
    private readonly store: Store,
    private readonly provider: SettlementProvider,
    private readonly cfg: MeterConfig,
  ) {}

  openSession(streamId: string, agent: string): Session {
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
    };
    this.store.putSession(session);
    return session;
  }

  /**
   * Settle one tick for a session and return the settlement plus how much was billed.
   * Throws (and halts the session) if the underlying payment did not land.
   */
  async settleTick(
    req: TickContext["req"],
    res: TickContext["res"],
    sessionId: string,
  ): Promise<{ session: Session; settlement: SettlementEvent; seconds: number }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new MeterError(404, "unknown session");
    if (session.status !== "active") throw new MeterError(409, `session is ${session.status}`);

    const stream = this.requireStream(session.streamId);
    const now = Date.now();
    const elapsedMs = Math.min(now - session.lastSettledAt, this.cfg.maxTickSeconds * 1000);
    const seconds = elapsedMs / 1000;
    const amount = (BigInt(stream.ratePerSecond) * BigInt(elapsedMs)) / 1000n;

    const ctx: TickContext = {
      session,
      stream,
      amount: amount.toString(),
      seconds,
      payTo: this.cfg.payTo,
      req,
      res,
    };

    let result;
    try {
      result = await this.provider.settleTick(ctx);
    } catch (err) {
      this.halt(session, (err as Error).message || "settlement failed");
      throw new MeterError(402, `tick unpaid — stream halted: ${(err as Error).message}`);
    }

    const event: SettlementEvent = {
      id: randomUUID(),
      sessionId: session.id,
      streamId: stream.id,
      agent: session.agent,
      payTo: this.cfg.payTo,
      amount: amount.toString(),
      asset: stream.asset,
      seconds,
      network: result.network,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      settledAt: now,
    };
    this.store.addEvent(event);

    session.lastSettledAt = now;
    session.settledMs += elapsedMs;
    session.ticks += 1;
    session.totalPaid = (BigInt(session.totalPaid) + amount).toString();
    this.store.putSession(session);

    return { session, settlement: event, seconds };
  }

  closeSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new MeterError(404, "unknown session");
    if (session.status === "active") {
      session.status = "closed";
      this.store.putSession(session);
    }
    return session;
  }

  private halt(session: Session, reason: string): void {
    session.status = "halted";
    session.haltedReason = reason;
    this.store.putSession(session);
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
