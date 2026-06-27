# SluiceRegistry — on-chain anchor for the streaming x402 economy

An [Odra](https://odra.dev) smart contract for Casper that makes the off-chain `/impact` proof feed
**verifiable against on-chain state**. The per-second meter settles via x402 `transfer_with_authorization`
(off-chain orchestration), but the *terms* of each stream and a tamper-evident *checkpoint* of its
cumulative settlement totals are recorded here — so anyone can read the registry and confirm the
numbers without trusting the Sluice server.

## Entry points
- `register_stream(stream_id, provider, rate_per_second)` — owner-gated; records a stream's terms.
- `checkpoint(stream_id, settlements, total_paid, seconds_streamed)` — owner-gated; anchors totals.
- `get_stream` / `get_settlements` / `get_total_paid` / `stream_count` — public reads.

## Build (Linux/Odra toolchain)
`cargo-odra` builds on Linux (it does not compile on Windows). On Ubuntu/WSL:

```bash
sudo apt-get install -y build-essential
cargo install cargo-odra
cargo odra build           # emits wasm/SluiceRegistry.wasm
```

## Deploy + sync (from anywhere with Node)
Deployment reuses the project's proven `casper-js-sdk` flow — no `casper-client` needed:

```bash
npx tsx scripts/registry.ts deploy   # install the WASM, save the package hash
npx tsx scripts/registry.ts sync     # register the 3 streams + checkpoint current /impact totals
```

> Note: Sluice already has a **deployed** Casper contract — our own CEP-18 `X402` token
> (package `658bb84b…1300017e`) that every settlement transfers against. This registry is the
> additional trust-minimisation anchor on the roadmap.
