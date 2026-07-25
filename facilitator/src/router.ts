/**
 * Sluice self-hosted x402 facilitator, as a mountable Express router.
 *
 * Why this exists
 * ---------------
 * A facilitator verifies an agent's signed EIP-712 authorization and submits the CEP-18
 * `transfer_with_authorization` on-chain, sponsoring the gas. Sluice used the public hosted
 * facilitator until it began building that call with the runtime argument named `value`, while the
 * reference Cep18X402 token's entry point reads `amount`. Every settlement then reverted on-chain
 * with a user error even though the signature, balance and authorization window were all valid.
 *
 * Running our own facilitator on the official @make-software/casper-x402 scheme removes that
 * dependency: the same package the token was built against also builds the settle call, so the
 * argument names agree by construction. Sluice keeps its existing token, its existing ledger, and
 * every settlement it has ever recorded.
 *
 * Verification and settlement are the official `registerExactCasperFacilitatorScheme`
 * implementation. This file is the HTTP surface plus the safety rails a facilitator that spends
 * real gas needs: shared-secret auth, an asset allowlist, and a payee allowlist, so it can never be
 * used as an open relay to drain the fee payer.
 */
import { Router, type Request, type Response } from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorCasperSigner, registerExactCasperFacilitatorScheme } from "@make-software/casper-x402";

export interface FacilitatorOptions {
  /** PEM key that sponsors settlement gas. */
  keyPath: string;
  /** CAIP-2 networks to serve, e.g. ["casper:casper-test"]. */
  networks: string[];
  /** Gas ceiling per settlement, in motes. A settle consumes roughly 2.8 CSPR. */
  paymentMotes: number;
  /** Shared secret required on every route except /health. Empty disables the gate. */
  secret?: string;
  /** Override the JSON-RPC endpoint. */
  rpcUrl?: string;
  /** Only settle transfers of these CEP-18 package hashes. Empty allows any. */
  allowedAssets: Set<string>;
  /** Only settle payments to these account addresses. Empty allows any. */
  allowedPayees: Set<string>;
}

const lower = (s: string) => s.trim().toLowerCase();

/** JSON-RPC endpoint for a network, overridable so a private node can be used. */
export function resolveRpc(network: string, override?: string): string {
  if (override) return override;
  return network === "casper:casper"
    ? "https://node.mainnet.casper.network/rpc"
    : "https://node.testnet.casper.network/rpc";
}

interface Requirements {
  asset?: string;
  payTo?: string;
  network?: string;
}

export async function createFacilitatorRouter(
  opts: FacilitatorOptions,
): Promise<{ router: Router; feePayer: string[] }> {
  const signer = await createFacilitatorCasperSigner(
    opts.keyPath,
    undefined,
    resolveRpc(opts.networks[0], opts.rpcUrl),
  );

  const facilitator = new x402Facilitator();
  registerExactCasperFacilitatorScheme(facilitator as never, {
    signer,
    networks: opts.networks as never,
    limitedPaymentMotes: opts.paymentMotes,
  });

  /** Refuse anything outside the allowlists, before it can spend a mote of our gas. */
  const screen = (requirements: Requirements | undefined): string | undefined => {
    if (!requirements) return "missing paymentRequirements";
    const asset = lower(String(requirements.asset || ""));
    const payTo = lower(String(requirements.payTo || ""));
    if (opts.allowedAssets.size && !opts.allowedAssets.has(asset)) {
      return `asset ${asset.slice(0, 16)} is not on this facilitator's allowlist`;
    }
    if (opts.allowedPayees.size && !opts.allowedPayees.has(payTo)) {
      return `payee ${payTo.slice(0, 16)} is not on this facilitator's allowlist`;
    }
    return undefined;
  };

  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", networks: opts.networks, feePayer: signer.getAddresses(opts.networks[0] as never) });
  });

  router.use((req: Request, res: Response, next) => {
    if (!opts.secret) return next();
    const sent = String(req.header("authorization") || "").replace(/^Bearer\s+/i, "");
    if (sent !== opts.secret) return res.status(401).json({ error: "unauthorized" });
    next();
  });

  router.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  router.post("/verify", async (req: Request, res: Response) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body ?? {};
      const refused = screen(paymentRequirements);
      if (refused) return res.json({ isValid: false, invalidReason: "unsupported_scheme", errorMessage: refused });
      res.json(await facilitator.verify(paymentPayload, paymentRequirements));
    } catch (err) {
      res.status(400).json({
        isValid: false,
        invalidReason: "unexpected_verify_error",
        errorMessage: (err as Error).message,
      });
    }
  });

  router.post("/settle", async (req: Request, res: Response) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    try {
      const refused = screen(paymentRequirements);
      if (refused) {
        return res.json({
          success: false,
          errorReason: "refused_by_allowlist",
          errorMessage: refused,
          transaction: "",
          network: paymentRequirements?.network ?? opts.networks[0],
        });
      }
      const result = await facilitator.settle(paymentPayload, paymentRequirements);
      if (!result.success) {
        console.error(`[facilitator] settle failed: ${result.errorReason} ${result.errorMessage ?? ""}`);
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({
        success: false,
        errorReason: "unexpected_settle_error",
        errorMessage: (err as Error).message,
        transaction: "",
        network: paymentRequirements?.network ?? opts.networks[0],
      });
    }
  });

  return { router, feePayer: signer.getAddresses(opts.networks[0] as never) };
}

/** Build the allowlists and options from environment, shared by standalone and mounted use. */
export function facilitatorOptionsFromEnv(): FacilitatorOptions {
  const listFromEnv = (name: string, fallback: string) =>
    new Set((process.env[name] || fallback).split(",").map(lower).filter(Boolean));

  return {
    keyPath: process.env.FACILITATOR_KEY_PATH || process.env.CLIENT_PRIVATE_KEY_PATH || "keys/agent.pem",
    networks: (process.env.FACILITATOR_NETWORKS || "casper:casper-test")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean),
    paymentMotes: parseInt(process.env.FACILITATOR_PAYMENT_MOTES || "5000000000", 10),
    secret: process.env.FACILITATOR_SHARED_SECRET || process.env.FACILITATOR_API_KEY || "",
    rpcUrl: process.env.FACILITATOR_RPC_URL,
    allowedAssets: listFromEnv("FACILITATOR_ALLOWED_ASSETS", process.env.ASSET_PACKAGE || ""),
    allowedPayees: listFromEnv(
      "FACILITATOR_ALLOWED_PAYEES",
      [
        process.env.PAYEE_ADDRESS,
        "00b76372880f98f0ddaf31257e32fb5b1b787a7bd9d20642dfac63b32ff7367a12",
        "0044f9e67c672341bcbcf5f444aa1541072d442526f644196d73eac124c737ad67",
        "00fc58cef2cb0adf3ade43868254aae8cfc4601f169e60c7ca6bf3a0f4aa85d491",
      ]
        .filter(Boolean)
        .join(","),
    ),
  };
}
