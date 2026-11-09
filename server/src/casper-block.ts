/**
 * Reading a Casper block for the casper-blocks stream. Pure functions with no network or timers, so
 * they can be tested on their own; feed.ts does the polling.
 */

/** A reading older than this is served as not live. */
export const CASPER_FRESH_MS = 15_000;

export interface CasperBlock {
  height: number;
  era: number;
  timestamp: string;
  transactions: number;
  proposer: string;
  gasPrice: number;
  fetchedAt: number;
}

/** The latest block out of a `chain_get_block` result (Casper 2.0 Version2 blocks, or Version1). */
export function parseCasperBlock(result: any, fetchedAt: number): CasperBlock | undefined {
  const block = result?.block_with_signatures?.block;
  const v = block?.Version2 ?? block?.Version1;
  const h = v?.header;
  if (!h || !Number.isFinite(Number(h.height)) || !h.timestamp || Number.isNaN(Date.parse(h.timestamp))) return undefined;
  const groups = Object.values(v?.body?.transactions ?? {}) as unknown[];
  const deploys = Array.isArray(v?.body?.deploy_hashes) ? v.body.deploy_hashes.length : 0;
  const transactions = groups.reduce<number>((n, g) => n + (Array.isArray(g) ? g.length : 0), 0) + deploys;
  return {
    height: Number(h.height),
    era: Number(h.era_id),
    timestamp: String(h.timestamp),
    transactions,
    proposer: String(h.proposer ?? v?.body?.proposer ?? ""),
    gasPrice: Number(h.current_gas_price ?? 1),
    fetchedAt,
  };
}

/** One tick's chunk from the latest reading. Never invents data: no reading, or an old one, is `live:false`. */
export function casperChunk(block: CasperBlock | undefined, tick: number, now: number) {
  const base = { network: "casper:casper", tick, ts: now, source: "casper-node" };
  if (!block) return { ...base, live: false, note: "waiting for the first block reading" };
  return {
    ...base,
    height: block.height,
    era: block.era,
    blockTime: block.timestamp,
    secondsSinceBlock: Math.max(0, Math.round((now - Date.parse(block.timestamp)) / 1000)),
    transactions: block.transactions,
    proposer: block.proposer ? `${block.proposer.slice(0, 10)}...` : "",
    gasPrice: block.gasPrice,
    live: now - block.fetchedAt < CASPER_FRESH_MS,
  };
}
