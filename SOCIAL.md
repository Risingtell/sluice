# Sluice — social & milestone drafts

Ready-to-post copy for build-in-public updates. All numbers are the honest, on-chain-verified
figures (283 settlements / 5 agents / 3 providers; verifier re-derives 301 ≥ 283 from the Casper
ledger, so the feed never over-claims).

- X handle: **[@agentsluice](https://x.com/agentsluice)**
- Repo: https://github.com/Risingtell/sluice
- Live proof: https://risingtell.github.io/sluice/
- Roadmap page: https://risingtell.github.io/sluice/roadmap.html
- Demo video: https://youtu.be/xIFQ-KtzsBw

---

## DoraHacks milestone — "Progress update" (Details field, ≤256 chars)

**Type:** Progress update · **Date:** 2026-07-02

Details (249 chars):

```
Live on Casper testnet: 283 on-chain settlements · 5 autonomous agents · 3 providers · 2 contracts · trustless verifier (chain 301 ≥ 283). Next: @sluice/x402 SDK, harden the meter, then Casper mainnet + open provider network. x.com/agentsluice
```

Related links:
- Related webpage: `https://risingtell.github.io/sluice/roadmap.html`
- GitHub repo: `https://github.com/Risingtell/sluice`
- X/Twitter post: *(paste the roadmap-thread URL after posting; otherwise leave blank)*

---

## DoraHacks milestone — long form (if a Details field allows more)

**Title:** Roadmap: from buildathon prototype to production

```
SHIPPED (Qualification Round):
• Per-second streaming x402 meter, live on Casper testnet
• 283 real on-chain settlements · 5 independent autonomous agents · 3 providers
• Two deployed Casper contracts: CEP-18 X402 token (658bb84b…) + SluiceRegistry (a7cbd09c…)
• Trustless on-chain verifier — every published number re-derived straight from the Casper ledger, so the feed can never over-claim (chain shows 301 ≥ the 283 we report)
• Real CoinGecko price feed driving the trading-agent streams

NOW → FINAL ROUND:
• Ship the @sluice/x402 SDK — any provider drops a streaming paywall on an endpoint in ~5 lines
• Harden the meter: micro-batched settlement, reconnection, quota-aware pacing

Q3 2026 — Casper mainnet launch with 2–3 design-partner data/compute providers; usage-based revenue share

Q4 2026 — open provider onboarding + an agent SDK so any autonomous agent can rent metered resources; pursue Casper grant / incubation

Follow build-in-public: x.com/agentsluice
```

---

## X (Twitter) — roadmap thread, post from @agentsluice

**1/**
```
Sluice roadmap 🧵

x402 charges agents *per request*. But agents rent things *continuously* — price feeds, GPU time, bandwidth. Sluice meters per second on Casper and shuts the gate the instant payment stops.

Here's what's shipped and what's next 👇
```

**2/**
```
✅ Shipped for the Casper Agentic Buildathon:
• Per-second streaming x402 meter, live on testnet
• 283 real on-chain settlements · 5 autonomous agents · 3 providers
• 2 deployed contracts (CEP-18 token + SluiceRegistry)
• Trustless verifier — re-derive every number from the chain
```

**3/**
```
🛠️ Now → finals:
• @sluice/x402 SDK — drop a streaming paywall on any endpoint in ~5 lines
• Harden the meter: micro-batch settlement, reconnection, quota-aware pacing
• Real price feeds already live via CoinGecko
```

**4/**
```
📈 Beyond the buildathon:
• Q3 2026 — Casper mainnet + 2–3 design-partner data/compute providers, usage-based revenue share
• Q4 2026 — open provider onboarding + agent SDK; pursue Casper grant / incubation
```

**5/**
```
Sluice is a real product, not a hackathon throwaway.

Code: github.com/Risingtell/sluice
Live proof: risingtell.github.io/sluice
Demo: youtu.be/xIFQ-KtzsBw

Build-in-public from here 👇 follow along.
```

*Single-tweet version:* tweet 1/ followed by the last two lines of 5/.
