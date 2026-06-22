/**
 * Settlement abstraction for the MOCK path.
 *
 * The streaming meter is decoupled from *how* a tick is paid. In MOCK mode (no creds) the
 * MockSettlementProvider simulates an on-chain settlement so the whole streaming UX + /impact proof
 * feed are buildable offline. In LIVE mode the @x402/express middleware settles the real CEP-18
 * `transfer_with_authorization` via the hosted facilitator, and the meter's commitTick() is driven
 * from the AfterSettleHook instead of from a provider — so this interface is the MOCK path only.
 */

import { randomBytes } from "node:crypto";
import type { SettlementResult, TickQuote } from "./meter.ts";

export interface SettlementProvider {
  readonly network: string;
  readonly mock: boolean;
  /** Settle one quoted tick. Must throw if the tick was not paid. */
  settle(quote: TickQuote): Promise<SettlementResult>;
}

/**
 * Simulates settlement with a synthetic 64-hex "deploy hash". No chain, no creds.
 * Adds a small artificial latency so timing/throughput behaviour resembles the live path.
 */
export class MockSettlementProvider implements SettlementProvider {
  readonly network = "mock";
  readonly mock = true;

  constructor(private readonly latencyMs = 40) {}

  async settle(_quote: TickQuote): Promise<SettlementResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    return { txHash: randomBytes(32).toString("hex"), explorerUrl: "", network: this.network };
  }
}
