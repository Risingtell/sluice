# @make-software/casper-x402 Resource Server Example

Express.js server demonstrating how to protect API endpoints with an x402 paywall on the Casper network, using `@x402/express` and `@make-software/casper-x402/exact/server`.

## Code shape

```typescript
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { AssetAmount } from "@x402/core/types";

const assetAmount: AssetAmount = {
  asset: assetPackage,
  amount: "7500000000",
  extra: { name: assetName, version: "1", decimals: "9" },
};

const casperScheme = new ExactCasperScheme()
  .registerAsset(chainID, assetPackage, 9)
  .registerMoneyParser(() => Promise.resolve(assetAmount));

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: chainID,
            payTo: cfg.payeeAddress,
          },
        ],
        description: "Get weather data for a city",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(chainID, casperScheme),
  ),
);

app.get("/weather", /* ... */);
app.get("/health", (_, res) => res.json({ status: "ok", version: "2.0.0" }));
```

## Prerequisites

- Node.js `v20+` (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm `v10` (install via [pnpm.io/installation](https://pnpm.io/installation))
- A running Casper x402 facilitator (see [`../facilitator/`](../facilitator/))
- A Casper account-hash (66 hex chars, `00`-prefixed) that receives payments
- A deployed CEP-18 token contract — its 64-char package hash is the asset

## Setup

Configuration is read from environment variables. See [`/.env.template`](../../../env.template) for the full template. The server uses:

| Variable | Required | Description |
| --- | --- | --- |
| `PAYEE_ADDRESS` | yes | 66-char account-hash that receives payments (e.g. `00abc...`) |
| `FACILITATOR_URL` | yes | Facilitator endpoint URL (default `http://localhost:4022`) |
| `FACILITATOR_API_KEY` | no | API key sent in the `Authorization` header |
| `CAIP2_CHAIN_ID` | yes | CAIP-2 network id, e.g. `casper:casper-test` |
| `ASSET_PACKAGE` | yes | 64-char package hash of the CEP-18 contract (`hash-` prefix optional) |
| `ASSET_NAME` | yes | Token name used in the EIP-712 domain |
| `PORT` | no | Server port (default `4021`) |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` (default `info`) |

## Run

Install and build all workspace packages, then start the server:

```bash
cd ../../            # js/ workspace root
pnpm install
pnpm build
cd examples/server
pnpm dev
```

The server listens on `http://localhost:4021`.

## Endpoints

### `GET /weather?city=<name>`

Paid weather report. First request returns `402 Payment Required` with a `PAYMENT-REQUIRED` header. After paying, the second request returns `200 OK` with a `PAYMENT-RESPONSE` header and the weather JSON.

### `GET /health`

Free healthcheck returning `{ "status": "ok", "version": "2.0.0" }`.

## Response format

The 402 response carries a base64-encoded JSON `PAYMENT-REQUIRED` header. The Casper-specific fields:

- `network` — CAIP-2 id, e.g. `casper:casper-test`
- `asset` — 64-char hex contract-package hash
- `payTo` — 66-char `00`-prefixed account-hash
- `extra.name` / `extra.version` — token name + version used in the EIP-712 domain

The 200 response carries a base64-encoded JSON `PAYMENT-RESPONSE` header with the settlement details (`transaction`, `network`, `payer`, `requirements`).

## Extending

To add more paid routes, append entries to the routes config and reuse `casperScheme`:

```typescript
"GET /your-endpoint": {
  accepts: [{
    scheme: "exact",
    price: "$0.10",
    network: chainID,
    payTo: cfg.payeeAddress,
  }],
  description: "Your endpoint description",
  mimeType: "application/json",
},
```

`network` accepts any [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) Casper identifier — `casper:casper` (mainnet), `casper:casper-test` (testnet), `casper:casper-net-1` (NCTL local).

## See also

- [`../facilitator/`](../facilitator/) — the Casper facilitator example
- [`../client/`](../client/) — the client that pays for `/weather`
- [`/go/examples/server`](../../../go/examples/server/) — the Go server this mirrors
