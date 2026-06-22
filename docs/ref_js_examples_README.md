# x402 TypeScript Examples

This folder contains runnable demos that show the full x402 payment flow on Casper. Each example is a standalone Node.js/TypeScript service that depends on the local `@make-software/casper-x402` package in `packages/mechanisms/casper`.

| Example | Path | Port | Purpose |
|---------|------|------|---------|
| **Facilitator** | `facilitator/` | `4022` | Verifies payment payloads and settles them on-chain |
| **Resource server** | `server/` | `4021` | Express endpoint protected by an x402 paywall |
| **Client** | `client/` | — | Pays for and fetches the protected weather report |

---

## Prerequisites

- Node.js `v20+` (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm `v10` (install via [pnpm.io/installation](https://pnpm.io/installation))
- A funded Casper account (ED25519 or SECP256K1) for the facilitator and for the client
- A deployed CEP-18 token contract package hash on the network you plan to use
- A Casper JSON-RPC endpoint (testnet, mainnet or local NCTL)

---

## Configuration

Copy the provided `.env` template and fill in values. Or use `.env.testnet` if you're going to test on the Testnet network with WCSPR contract.

---

## Build the package

Before running the examples, install dependencies once from the repository root and build the local `@make-software/casper-x402` package so the examples can resolve it:

```bash
pnpm install
pnpm build
```

---

## Run the examples

Open three terminals and start the services in this order:

### 1. Start the facilitator

```bash
# from the repository root
pnpx tsx js/examples/facilitator/index.ts
```

You should see:

```text
🚀 Facilitator listening on http://localhost:4022
```

### 2. Start the resource server

```bash
# from the repository root
pnpx tsx js/examples/server/index.ts
```

You should see:

```text
Server listening at http://localhost:4021
```

### 3. Run the client

```bash
# from the repository root
pnpx tsx js/examples/client/index.ts
```

On success, the client prints the weather response and the facilitator logs the verified/settled payment.

---

## Example endpoints

### `GET /weather` (resource server)

Returns a simple weather report once a valid payment signature is provided.

#### First request — payment required

```http
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64-encoded payment requirements>
```

#### Second request — paid response

```http
HTTP/1.1 200 OK
PAYMENT-RESPONSE: <base64-encoded settlement result>

{"report":{"weather":"sunny","temperature":70}}
```

### `GET /supported` (facilitator)

Returns the payment schemes and networks supported by the facilitator:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "casper:casper-test",
      "extra": { "feePayer": "..." }
    }
  ],
  "extensions": [],
  "signers": { "casper:*": ["..."] }
}
```

### `POST /verify` and `POST /settle` (facilitator)

These endpoints accept a `{ paymentPayload, paymentRequirements }` body and return verification/settlement results. The resource server calls them automatically via the `@x402/core/server` `HTTPFacilitatorClient`.

---

## Network identifiers

The examples default to Casper Testnet (`casper:casper-test`). You can switch to mainnet or a local NCTL network by updating the `CASPER_RPC_URL` and the network strings in the source files.

Casper CAIP-2 identifiers:

- `casper:casper` — Casper Mainnet
- `casper:casper-test` — Casper Testnet
- `casper:casper-net-1` - Casper NCTL local test network

---

## Troubleshooting

- **Module not found for `@make-software/casper-x402`** — make sure you ran `pnpm install` and `pnpm build` from the repository root.
- **Facilitator returns `invalid_signature`** — verify that the client and facilitator are configured for the same network and that the token `name`/`version` in the server’s `extra` metadata match the CEP-18 contract’s EIP-712 domain.
- **Settlement fails with an RPC error** — confirm the facilitator account has enough CSPR for gas and that the CEP-18 contract package hash is correct.
