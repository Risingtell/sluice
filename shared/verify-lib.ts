/**
 * Pure verification logic, shared by `npm run verify` and the test suite.
 *
 * Kept free of I/O so the same rules that produce the public claim can be asserted directly
 * against the committed on-chain ledger snapshot in tests.
 */

export interface LedgerAction {
  from_hash?: string;
  to_hash?: string;
  amount?: string;
  deploy_hash?: string;
}

export interface DerivedSettlements {
  /** Settlements grouped by provider label. */
  perProvider: Record<string, { count: number; total: bigint }>;
  /** Deploy hashes of real agent-to-provider settlement transfers. */
  settledHashes: Set<string>;
  count: number;
  total: bigint;
}

/**
 * Re-derive settlements from raw CEP-18 token actions.
 *
 * A settlement is a transfer FROM a consumer agent TO a non-agent (a provider). That rule cleanly
 * excludes the initial mint and the agent-funding transfers without needing to enumerate them.
 */
export function deriveSettlements(
  actions: LedgerAction[],
  agents: Set<string>,
  providerNames: Record<string, string> = {},
): DerivedSettlements {
  const perProvider: Record<string, { count: number; total: bigint }> = {};
  const settledHashes = new Set<string>();
  let count = 0;
  let total = 0n;

  for (const a of actions) {
    const from = (a.from_hash || "").toLowerCase();
    const to = (a.to_hash || "").toLowerCase();
    if (!agents.has(from) || agents.has(to)) continue;
    const name = providerNames[to] || `provider ${to.slice(0, 10)}`;
    perProvider[name] ??= { count: 0, total: 0n };
    perProvider[name].count++;
    perProvider[name].total += BigInt(a.amount || "0");
    settledHashes.add(String(a.deploy_hash || "").toLowerCase());
    count++;
    total += BigInt(a.amount || "0");
  }

  return { perProvider, settledHashes, count, total };
}

/**
 * Rows the feed publishes that have no matching on-chain settlement transfer.
 *
 * Totals alone are a weak test: a row whose transfer never landed still hides under a bigger
 * on-chain total. A reverted deploy also still carries a transaction hash, so a well-formed hash
 * proves nothing on its own. Matching hash-by-hash is what actually catches an unbacked claim.
 */
export function findUnbacked<T extends { txHash?: string }>(rows: T[], settledHashes: Set<string>): T[] {
  return rows.filter((r) => !settledHashes.has(String(r.txHash || "").toLowerCase()));
}
