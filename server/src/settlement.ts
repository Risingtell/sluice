/**
 * Settlement abstraction.
 *
 * The streaming meter is deliberately decoupled from *how* a tick is paid. In MOCK mode
 * (no creds needed) the MockSettlementProvider simulates an on-chain settlement so the whole
 * streaming UX + /impact proof feed are buildable offline. In LIVE mode (D2) the Casper x402
 * provider records the real CEP-18 `transfer_with_authorization` that the @x402/express
 * middleware settled via the hosted facilitator.
 */

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { Session, StreamSpec } from "../../shared/types.ts";

export interface TickContext {
  session: Session;
  stream: StreamSpec;
  /** Motes owed for this tick. */
  amount: string;
  /** Seconds of consumption this tick covers. */
  seconds: number;
  payTo: string;
  req: Request;
  res: Response;
}

export interface SettlementResult {
  txHash: string;
  explorerUrl: string;
  network: string;
}

export interface SettlementProvider {
  readonly network: string;
  readonly mock: boolean;
  /** Settle (or confirm settlement of) one tick. Must throw if the tick was not paid. */
  settleTick(ctx: TickContext): Promise<SettlementResult>;
}

/**
 * Simulates settlement with a synthetic 64-hex "deploy hash". No chain, no creds.
 * Adds a small artificial latency so timing/throughput behaviour resembles the live path.
 */
export class MockSettlementProvider implements SettlementProvider {
  readonly network = "mock";
  readonly mock = true;

  constructor(private readonly latencyMs = 40) {}

  async settleTick(_ctx: TickContext): Promise<SettlementResult> {
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }
    const txHash = randomBytes(32).toString("hex");
    return { txHash, explorerUrl: "", network: this.network };
  }
}
