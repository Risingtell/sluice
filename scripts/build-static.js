/**
 * Build a static GitHub Pages mirror of the Sluice proof feed into ./docs.
 *
 * GitHub Pages is free forever, never sleeps, and is independent of any machine — the ideal
 * always-on home for the public proof page judges open. It serves a *snapshot* of the real
 * settlements (every row keeps its real Casper tx hash + cspr.live explorer link); the live
 * real-time ticking is shown in the demo video and runnable locally.
 *
 * Run: `node scripts/build-static.js`  (re-run anytime to refresh the snapshot after more volume).
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";

const DATA = process.env.SNAPSHOT_PATH || "server/.data/impact.json";
const OUT = "docs";
const NETWORK = "casper:casper-test";
const TOTALS_ASSET = "Casper X402 Token";

mkdirSync(OUT, { recursive: true });

// 1) Compute the same ImpactSnapshot shape the server's /impact returns, from the durable data.
const raw = JSON.parse(readFileSync(DATA, "utf8"));
const events = raw.events ?? [];
let totalPaid = 0n;
let secondsStreamed = 0;
const agents = new Set();
const providers = new Set();
for (const e of events) {
  totalPaid += BigInt(e.amount || "0");
  secondsStreamed += e.seconds || 0;
  agents.add(e.agent);
  providers.add(e.payTo);
}
const snapshot = {
  network: NETWORK,
  mock: false,
  static: true,
  generatedAt: Date.now(),
  totals: {
    settlements: events.length,
    totalPaid: totalPaid.toString(),
    asset: TOTALS_ASSET,
    activeSessions: 0,
    uniqueAgents: agents.size,
    uniqueProviders: providers.size,
    secondsStreamed: Math.round(secondsStreamed),
  },
  recent: events.slice(-50).reverse(),
  decisions: (raw.sessions ?? [])
    .filter((s) => s.closedReason && !/^tick unpaid|^stream interrupted|^stream halted/.test(s.closedReason))
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, 8)
    .map((s) => ({
      agent: s.agent,
      streamId: s.streamId,
      provider: { "btc-usd": "Lumen Markets", "eth-usd": "Helios Feeds", "gpu-telemetry": "NimbusGPU" }[s.streamId],
      objective: s.objective,
      closedReason: s.closedReason,
      ticks: s.ticks,
      totalPaid: s.totalPaid,
      at: s.closedAt ?? s.startedAt,
    })),
};
writeFileSync(`${OUT}/proof.json`, JSON.stringify(snapshot));
console.log(`proof.json: ${snapshot.totals.settlements} settlements, ${snapshot.totals.secondsStreamed}s, ${agents.size} agent(s)`);

// 2) Copy the two pages and rewrite server paths → static relative paths.
function staticize(html) {
  return html
    .replaceAll('fetch("/impact")', 'fetch("./proof.json")')
    .replaceAll('href="/index.html"', 'href="index.html"')
    .replaceAll('href="/impact.html"', 'href="impact.html"');
}
for (const page of ["index.html", "impact.html"]) {
  const src = `server/public/${page}`;
  if (!existsSync(src)) continue;
  writeFileSync(`${OUT}/${page}`, staticize(readFileSync(src, "utf8")));
}
// GitHub Pages: don't run Jekyll over our files.
writeFileSync(`${OUT}/.nojekyll`, "");
console.log("static mirror written to ./docs");
