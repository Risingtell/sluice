/**
 * Server side of the buyer-settle scheme (see shared/buyer-settle.ts): the buyer submits and pays
 * for its own CEP-18 transfer, and this server only reads the chain.
 *
 * Two small pieces plug it into the standard @x402 resource server, next to the "exact" scheme:
 *   - BuyerSettleServerScheme builds the payment requirements (token, amount, payee, and the
 *     quote's nonce in `extra`).
 *   - BuyerSettleFacilitator is an in-process facilitator for this one scheme. Its verify checks the
 *     buyer's claim signature, reads the buyer's transaction from a Casper node and checks it
 *     executed exactly the transfer asked for, from the key that signed the claim. Its settle
 *     submits nothing and spends nothing: it marks the transaction used and reports it.
 */
import casperSdk from "casper-js-sdk";
import type { FacilitatorClient } from "@x402/core/server";
import type { AssetAmount, Network, PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { SCHEME_BUYER_SETTLE, claimMessage, confirmSettlement, isHex64, type SettlementCheck, type SettlementExpectation } from "../../shared/buyer-settle.ts";
import { chainNameFor } from "../../shared/networks.ts";

const ADDRESS = /^00[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;

export class BuyerSettleServerScheme {
  readonly scheme = SCHEME_BUYER_SETTLE;

  async parsePrice(price: unknown, _network: Network): Promise<AssetAmount> {
    // Sluice always prices a tick as an exact token amount; there is no dollar conversion here.
    if (typeof price === "object" && price !== null && "amount" in price && "asset" in price) return price as AssetAmount;
    throw new Error("buyer-settle needs an exact { amount, asset } price");
  }

  getAssetDecimals(): number {
    return 9;
  }

  async enhancePaymentRequirements(req: PaymentRequirements): Promise<PaymentRequirements> {
    if (!isHex64(req.asset)) throw new Error(`buyer-settle: invalid token package ${req.asset}`);
    if (!ADDRESS.test(req.payTo)) throw new Error(`buyer-settle: invalid payee ${req.payTo}`);
    if (!isHex64((req.extra as Record<string, unknown> | undefined)?.nonce)) throw new Error("buyer-settle: every quote needs a 32-byte nonce");
    return req;
  }
}

interface BuyerSettlePayload {
  transactionHash?: string;
  /** Hex public key of the paying account. */
  publicKey?: string;
  /** Hex signature, by publicKey, over claimMessage(network, nonce, transactionHash). */
  claimSignature?: string;
}

export interface BuyerSettleFacilitatorOptions {
  /** Networks this scheme is offered on, each with the Casper node to read it from. */
  rpcByNetwork: Record<string, string>;
  /**
   * How long verify waits for a transaction to show as executed. Short on purpose: the buyer's SDK
   * only sends a hash after seeing it execute, so a long wait only helps someone sending made-up
   * hashes to tie the server up.
   */
  waitMs?: number;
  /** Chain reads allowed at once; requests beyond it are refused at once, to be retried. */
  maxInFlight?: number;
  /** Test seam: replaces the chain read. */
  confirm?: (rpcUrl: string, hash: string, expect: SettlementExpectation) => Promise<SettlementCheck>;
}

/** Keeps the last few thousand settled transactions, so a payment is never counted twice. */
const USED_LIMIT = 5_000;
/** A verified transaction stays usable by settle for this long without a second chain read. */
const VERIFIED_TTL_MS = 10 * 60_000;

type Verified = { key: string; payer: string; at: number };
type Checked = { ok: true; hash: string; payer: string } | { ok: false; reason: string };

export class BuyerSettleFacilitator implements FacilitatorClient {
  private readonly used = new Set<string>();
  private readonly verified = new Map<string, Verified>();
  private inFlight = 0;
  private readonly confirm: NonNullable<BuyerSettleFacilitatorOptions["confirm"]>;

  constructor(private readonly opts: BuyerSettleFacilitatorOptions) {
    this.confirm = opts.confirm ?? ((rpc, hash, expect) => confirmSettlement(rpc, hash, expect, { waitMs: opts.waitMs ?? 15_000, pollMs: 2_500 }));
  }

  async getSupported(): Promise<SupportedResponse> {
    const kinds = Object.keys(this.opts.rpcByNetwork).map((network) => ({ x402Version: 2, scheme: SCHEME_BUYER_SETTLE, network: network as Network }));
    return { kinds, extensions: [], signers: {} };
  }

  /** Everything that must hold for this payload to pay this requirement. */
  private async check(payload: PaymentPayload, req: PaymentRequirements): Promise<Checked> {
    if (req.scheme !== SCHEME_BUYER_SETTLE || payload.accepted?.scheme !== SCHEME_BUYER_SETTLE) return { ok: false, reason: "not a buyer-settle payment" };
    if (payload.accepted.network !== req.network) return { ok: false, reason: "network mismatch" };
    const rpc = this.opts.rpcByNetwork[req.network];
    if (!rpc) return { ok: false, reason: `buyer-settle is not offered on ${req.network}` };

    const p = (payload.payload ?? {}) as BuyerSettlePayload;
    const hash = String(p.transactionHash ?? "").toLowerCase();
    if (!isHex64(hash)) return { ok: false, reason: "payload.transactionHash must be 64 hex characters" };
    if (this.used.has(hash)) return { ok: false, reason: "this transaction already paid for a tick" };
    const nonce = String((req.extra as Record<string, unknown> | undefined)?.nonce ?? "").toLowerCase();

    // 1. The claim: only the key that paid can sign it, so a hash copied off the chain is useless
    //    to anyone else. Checked before any chain read, since it costs nothing.
    let payerFromKey: string;
    try {
      const sig = String(p.claimSignature ?? "").toLowerCase();
      if (!HEX.test(sig) || sig.length % 2) throw new Error("claimSignature must be hex");
      const key = casperSdk.PublicKey.fromHex(String(p.publicKey ?? ""));
      if (!key.verifySignature(claimMessage(req.network, nonce, hash), Uint8Array.from(sig.match(/../g)!, (h) => parseInt(h, 16)))) throw new Error("bad claim signature");
      payerFromKey = "00" + key.accountHash().toHex();
    } catch (err) {
      return { ok: false, reason: `claim not signed by the paying key (${(err as Error).message.slice(0, 80)})` };
    }

    // 2. The transfer: read once; settle reuses a verify of the same transfer for the same quote.
    const key = `${req.network}|${req.asset}|${req.payTo}|${req.amount}|${nonce}|${payerFromKey}`;
    const known = this.verified.get(hash);
    if (known && known.key === key && Date.now() - known.at < VERIFIED_TTL_MS) return { ok: true, hash, payer: known.payer };

    if (this.inFlight >= (this.opts.maxInFlight ?? 16)) return { ok: false, reason: "server busy checking other payments; retry with the same transaction" };
    this.inFlight++;
    let result: SettlementCheck;
    try {
      result = await this.confirm(rpc, hash, { asset: req.asset, payTo: req.payTo, amount: req.amount, nonce, chainName: chainNameFor(req.network) });
    } finally {
      this.inFlight--;
    }
    if (!result.ok) return { ok: false, reason: result.reason };
    if (result.payer !== payerFromKey) return { ok: false, reason: "the claim is signed by a different account than the one that paid" };

    this.verified.set(hash, { key, payer: result.payer, at: Date.now() });
    if (this.verified.size > USED_LIMIT) this.verified.delete(this.verified.keys().next().value as string);
    return { ok: true, hash, payer: result.payer };
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const c = await this.check(payload, req);
    if (!c.ok) return { isValid: false, invalidReason: "invalid_buyer_settle", invalidMessage: c.reason } as VerifyResponse;
    return { isValid: true, payer: c.payer } as VerifyResponse;
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const c = await this.check(payload, req);
    if (!c.ok) return { success: false, errorReason: "invalid_buyer_settle", errorMessage: c.reason, transaction: "", network: req.network } as SettleResponse;
    // Claim the transaction before anything else can: a second request racing with the same hash
    // finds it used here, even if both passed verify.
    if (this.used.has(c.hash)) return { success: false, errorReason: "invalid_buyer_settle", errorMessage: "this transaction already paid for a tick", transaction: "", network: req.network } as SettleResponse;
    this.used.add(c.hash);
    this.verified.delete(c.hash);
    if (this.used.size > USED_LIMIT) this.used.delete(this.used.values().next().value as string);
    return { success: true, transaction: c.hash, network: req.network, payer: c.payer } as SettleResponse;
  }
}
