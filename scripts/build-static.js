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
// Defense in depth: the PUBLIC proof only ever contains real on-chain settlements. Mock/simulated
// events (network "mock", no explorer link) are excluded even if a snapshot ever gets mixed.
const events = (raw.events ?? []).filter((e) => e.network !== "mock" && e.explorerUrl);
let totalPaid = 0n;
let secondsStreamed = 0;
const agents = new Set();
const providers = new Set();
// Same provider-name mapping the server's stream catalogue uses — count distinct provider
// businesses, not payout addresses (an address rotation is still the same provider).
const PROVIDER_BY_STREAM = { "btc-usd": "Lumen Markets", "eth-usd": "Helios Feeds", "gpu-telemetry": "NimbusGPU" };
for (const e of events) {
  totalPaid += BigInt(e.amount || "0");
  secondsStreamed += e.seconds || 0;
  agents.add(e.agent);
  providers.add(PROVIDER_BY_STREAM[e.streamId] ?? e.payTo);
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

// 2) Copy the pages and rewrite server paths → static relative paths.
// The demo console needs the live server, so on the static mirror its links either point at the
// deployed demo host (DEMO_URL, no trailing slash) or are removed entirely. Never a dead link.
const DEMO_URL = (process.env.DEMO_URL || "").replace(/\/$/, "");
function staticize(html) {
  html = html
    .replaceAll('fetch("/impact")', 'fetch("./proof.json")')
    .replaceAll('href="/index.html"', 'href="index.html"')
    .replaceAll('href="/impact.html"', 'href="impact.html"')
    .replaceAll('href="/roadmap.html"', 'href="roadmap.html"');
  if (DEMO_URL) {
    html = html.replaceAll('href="/demo.html" data-demo-link', `href="${DEMO_URL}/demo.html" data-demo-link`);
  } else {
    html = html.replace(/[ \t]*<a [^>]*data-demo-link[^>]*>.*?<\/a>\n?/g, "");
  }
  return html;
}
for (const page of ["index.html", "impact.html", "roadmap.html"]) {
  const src = `server/public/${page}`;
  if (!existsSync(src)) continue;
  writeFileSync(`${OUT}/${page}`, staticize(readFileSync(src, "utf8")));
}
// GitHub Pages: don't run Jekyll over our files.
writeFileSync(`${OUT}/.nojekyll`, "");
console.log("static mirror written to ./docs");
