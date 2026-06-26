/**
 * Shared wire types between the Sluice resource server and the consuming agent.
 * Amounts are integer strings in the smallest token unit ("motes" for CSPR: 1 CSPR = 1e9 motes).
 */

export type SessionStatus = "active" | "halted" | "closed";

/** A continuously-metered resource an agent can stream. */
export interface StreamSpec {
  id: string;
  title: string;
  description: string;
  /** Price per second of consumption, in motes. */
  ratePerSecond: string;
  /** Token symbol settlements are denominated in (e.g. WCSPR). */
  asset: string;
  /** Display name of the provider that supplies this stream. */
  provider?: string;
  /** Casper address (00 + account-hash) the provider receives payment at. */
  payTo?: string;
}

/** A live consumption session: one agent streaming one resource. */
export interface Session {
  id: string;
  streamId: string;
  /** Agent's Casper public key / address (or a mock id in MOCK mode). */
  agent: string;
  status: SessionStatus;
  startedAt: number;
  /** Wall-clock ms of metered consumption that has been settled. */
  settledMs: number;
  /** Cumulative motes settled across all ticks of this session. */
  totalPaid: string;
  /** Number of on-chain settlements (ticks) so far. */
  ticks: number;
  lastSettledAt: number;
  haltedReason?: string;
}

/** One on-chain (or simulated) settlement event — the unit of the /impact proof feed. */
export interface SettlementEvent {
  id: string;
  sessionId: string;
  streamId: string;
  agent: string;
  payTo: string;
  /** Display name of the provider that received this payment. */
  provider?: string;
  /** Motes moved in this single tick. */
  amount: string;
  asset: string;
  /** Seconds of consumption this tick covers. */
  seconds: number;
  /** "mock" or "casper-test". */
  network: string;
  /** Settlement / deploy hash. Synthetic in MOCK mode, real CEP-18 transfer hash when live. */
  txHash: string;
  /** Deep link to a block explorer when live; empty in MOCK mode. */
  explorerUrl: string;
  settledAt: number;
}

export interface OpenSessionRequest {
  streamId: string;
  agent: string;
}

export interface TickResponse {
  session: Session;
  settlement: SettlementEvent;
  /** The next chunk of the streamed resource, delivered only because the tick was paid. */
  data: unknown;
}

export interface ImpactSnapshot {
  network: string;
  mock: boolean;
  totals: {
    settlements: number;
    totalPaid: string;
    asset: string;
    activeSessions: number;
    uniqueAgents: number;
    uniqueProviders: number;
    secondsStreamed: number;
  };
  recent: SettlementEvent[];
}
