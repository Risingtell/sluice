# Sluice — judge's scorecard & competitive read

*Written from the position of a Casper Agentic Buildathon judge, scoring against DoraHacks' standard
BUIDL rubric (Innovation, Technical, Practicality, Completeness, Presentation) plus theme-fit
(agentic + Casper x402). Honest, not promotional.*

## Verdict

**Strong qualifier, top-tier on concept — gated entirely by one operational gap: the repo is not
yet public.** Fix that and Sluice is a genuine podium contender. The differentiator (per-second
*streaming* settlement) is real and, from the full 64-BUIDL field, still unoccupied. It is live and
on-chain-verifiable, which most entries are not.

## Scores (1–10)

| Criterion | Score | Why |
|---|---|---|
| **Innovation / originality** | **9** | Whole field is discrete pay-per-request x402 or escrow/reputation plumbing. Continuous per-second streaming settlement with a self-closing "gate" is a distinct primitive, not a re-skin. |
| **Technical implementation** | **8** | Real EIP-712 `transfer_with_authorization` settled by the live Casper facilitator; own CEP-18 token deployed; clean quote/commit meter split; MOCK/LIVE behind one interface. Loses a point: single-node in-memory state, one funded agent. |
| **Practicality / impact** | **8** | Names real buyers — trading agents on live feeds, GPU rental, streaming inference. Clear "why per-second beats credits/subscriptions." |
| **Completeness / functionality** | **7→9** | The *product* is done and proven (138 real settlements). Was held back by no LICENSE / vendored code / no public repo. Two of three now fixed; **public repo is the remaining blocker.** |
| **Presentation / UX** | **8** | Cohesive landing + redesigned live proof dashboard; clickable on-chain verification. Needs the demo video + a stable public URL to max out. |
| **Theme fit (agentic + x402)** | **9** | Dead-center: autonomous agent, Casper x402 `exact` scheme, sponsored facilitator. |

## Disqualification / risk audit

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **P0 — blocker** | **No public repo.** No git remote; `github.com/Risingtell/sluice` (linked in README + landing) 404s. A submission must be a public, accessible repo. | **OPEN — needs owner GitHub push** |
| 2 | P1 | README claimed MIT but no LICENSE file (open-source eligibility). | ✅ Fixed (added `LICENSE`) |
| 3 | P1 | `docs/ref_js_*` were verbatim third-party source vendored from the casper-x402 repo — originality/attribution risk, imported nowhere. | ✅ Fixed (removed) |
| 4 | P2 | Exposed cspr.cloud facilitator key (shared during dev). Not in git, but must be rotated. | OPEN — rotate post-event |
| 5 | P2 | `uniqueAgents = 1` — all volume from one funded key. Not dishonest (it's disclosed) but a judge will notice. | Disclosed everywhere; optional to onboard more agents |
| 6 | P3 | Single-node, in-memory state with JSON snapshot — fine for a hackathon, not production HA. | Acknowledged in writeups |

## Bugs found & fixed

- **Billing-clock skew (logic):** the LIVE quote cache (`pending`) only cleared on settle
  success/failure. An abandoned 402 challenge or a hookless failure left a stale quote that the next
  tick reused — billing the old elapsed window and skewing the session clock. **Fixed:** quotes now
  expire after 30s (`freshPending`), so the next tick always re-quotes fresh wall-clock time.
- **Dashboard script syntax error:** an unquoted hyphenated object key (`{ btc-usd: … }`) would have
  thrown and blanked the entire proof feed. **Fixed.**

## Competitive read (from the full field)

- **Phoenix Zero** — live discrete x402 health-oracle, 206K+ datapoints. Sets a high *traction* bar →
  Sluice must keep growing `/impact` volume and lead with the verifiable count.
- **Sella** — agentic marketplace for paywalled APIs/GPU. Domain overlap, but access-model, not
  per-second streaming. Differentiate on the *mechanism*, never frame Sluice as a marketplace.
- Everyone else: discrete pay-per-call or trust/escrow/oracle plumbing. **The streaming lane is open.**

## To convert "qualifier" → "winner" (ranked)

1. **Publish the repo** (P0). One `gh repo create` + push. Nothing else matters until this is done.
2. **Stable public URL** for `/impact.html` (Cloudflare named tunnel — see `HOSTING.md`).
3. **Demo video** that proves it live and clicks through to the explorer (`DEMO_SCRIPT.md`).
4. **Grow `/impact` volume** before judging (`scripts/volume.sh`) to answer the traction bar.
5. *(Optional, high-credibility)* onboard 2–3 more funded agents to lift `uniqueAgents` honestly.
