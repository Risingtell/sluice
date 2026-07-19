/**
 * Merge settlements minted on a deployed Sluice host (e.g. the public demo console) into the
 * local canonical proof history, so the static proof site and the committed seed stay complete.
 *
 *   REMOTE=https://sluice-kff3.onrender.com npx tsx scripts/sync-remote.ts
 *
 * Only merges events with a real explorer link (on-chain settlements); dedupes by txHash. The
 * on-chain verifier stays the ultimate source of truth either way (chain >= feed, always).
 */
import { readFileSync, writeFileSync } from "node:fs";

const REMOTE = (process.env.REMOTE || "https://sluice-kff3.onrender.com").replace(/\/$/, "");
const SNAPSHOT = process.env.SNAPSHOT_PATH || "server/.data/impact.json";

async function main() {
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const seen = new Set(snap.events.map((e: any) => e.txHash));

  const res = await fetch(`${REMOTE}/impact`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${REMOTE}/impact -> HTTP ${res.status}`);
  const remote = await res.json();

  const fresh = (remote.recent || [])
    .filter((e: any) => e.network !== "mock" && e.explorerUrl && !seen.has(e.txHash))
    .sort((a: any, b: any) => a.settledAt - b.settledAt);

  if (!fresh.length) {
    console.log(`no new settlements on ${REMOTE} (local ${snap.events.length}, remote ${remote.totals?.settlements})`);
    return;
  }
  snap.events.push(...fresh);
  snap.events.sort((a: any, b: any) => a.settledAt - b.settledAt);
  writeFileSync(SNAPSHOT, JSON.stringify(snap));
  console.log(`merged ${fresh.length} new settlement(s) from ${REMOTE}; local history now ${snap.events.length}`);
}

main().catch((e) => { console.error("ERROR:", (e as Error).message); process.exit(1); });
