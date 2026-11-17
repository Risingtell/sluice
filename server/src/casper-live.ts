/**
 * LIVE Casper x402 wiring.
 *
 * Mounts a single protected tick endpoint `POST /tick?session=<id>` behind @x402/express's
 * paymentMiddleware. Per tick:
 *   1. DynamicPrice quotes meter.quoteTick(session) → the exact motes owed this tick (cached so the
 *      402-challenge and the signed retry agree on the amount).
 *   2. The middleware verifies the agent's EIP-712 authorization and settles a real CEP-18
 *      transfer_with_authorization via the hosted facilitator (which pays the gas).
 *   3. onAfterSettle fires with the real on-chain tx hash → meter.commitTick records it to the
 *      /impact proof feed and advances the session.
 * Skip/refuse a tick → no settlement → the next chunk never comes. The sluice gate shuts.
 *
 * Who pays the gas is set per network. On a sponsored network the 402 offers "exact", where the
 * facilitator submits the transfer and pays its gas, as above. On a buyer-settle network it offers
 * "buyer-settle" (shared/buyer-settle.ts), where the buyer submits the same transfer from its own
 * account and pays its own gas, and this server only reads the chain. A network can offer both;
 * mainnet is never sponsored unless SPONSORED_NETWORKS says so.
 */
import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient, type FacilitatorConfig } from "@x402/core/server";
import type { AssetAmount, Network } from "@x402/core/types";
import type { ServerConfig } from "./config.ts";
import { StreamingMeter, MeterError, type TickQuote } from "./meter.ts";
import { nextChunk } from "./feed.ts";
import type { TickResponse } from "../../shared/types.ts";
import { explorerTxUrl, rpcFor, rpcOverride } from "../../shared/networks.ts";
import { SCHEME_BUYER_SETTLE } from "../../shared/buyer-settle.ts";
import { BuyerSettleFacilitator, BuyerSettleServerScheme, type BuyerSettleFacilitatorOptions } from "./buyer-settle.ts";

interface HTTPReqCtx {
  path: string;
  getQueryParam?: (name: string) => string | string[] | undefined;
  adapter?: { getQueryParam?: (name: string) => string | string[] | undefined };
}

function sessionIdFrom(ctx: { getQueryParam?: HTTPReqCtx["getQueryParam"]; adapter?: HTTPReqCtx["adapter"] } | undefined): string | undefined {
  const q = ctx?.getQueryParam?.("session") ?? ctx?.adapter?.getQueryParam?.("session");
  return Array.isArray(q) ? q[0] : q;
}

export function mountCasperLive(
  app: Express,
  cfg: ServerConfig,
  meter: StreamingMeter,
  /** Test seam: replaces the buyer-settle chain read. */
  deps: { confirm?: BuyerSettleFacilitatorOptions["confirm"] } = {},
): void {
  const sponsored = new Set(cfg.sponsoredNetworks);
  const buyerSettle = new Set(cfg.buyerSettleNetworks);
  if (sponsored.size && !cfg.facilitatorApiKey) throw new Error("sponsoring gas requires FACILITATOR_API_KEY");
  if (!cfg.networks.length) throw new Error("LIVE mode requires at least one network");
  for (const n of cfg.networks) {
    if (!n.assetPackage) throw new Error(`LIVE mode requires a token package for ${n.id} (ASSET_PACKAGE_MAINNET / ASSET_PACKAGE_TESTNET)`);
  }

  // Facilitator client — raw `Authorization: <key>` on every facilitator call (verified format).
  const auth = { Authorization: cfg.facilitatorApiKey };
  const facilitatorConfig: FacilitatorConfig = {
    url: cfg.facilitatorUrl,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth, bazaar: auth }),
  };
  const facilitators: FacilitatorClient[] = [];
  if (sponsored.size) facilitators.push(new HTTPFacilitatorClient(facilitatorConfig));
  // Buyer-settle needs no facilitator service and no key: it only reads each network's node.
  if (buyerSettle.size) {
    const rpcByNetwork = Object.fromEntries(
      cfg.networks.filter((n) => buyerSettle.has(n.id)).map((n) => [n.id, rpcOverride(n.id, process.env, cfg.networks.length) || rpcFor(n.id)]),
    );
    facilitators.push(new BuyerSettleFacilitator({ rpcByNetwork, confirm: deps.confirm }));
  }

  // EIP-712 domain fields must match the deployed token exactly. The token is the same reference
  // contract on every network, deployed under the same name, so only its package hash differs.
  const tokenExtra = { name: cfg.assetName, symbol: "X402", version: "1", decimals: "9" };
  const casperScheme = new ExactCasperScheme().registerMoneyParser(() =>
    Promise.resolve({ asset: cfg.networks[0].assetPackage, amount: "0", extra: tokenExtra } as AssetAmount),
  );
  for (const n of cfg.networks) casperScheme.registerAsset(n.id as Network, n.assetPackage, 9);
  const buyerScheme = new BuyerSettleServerScheme();

  // Each settlement links to the explorer of the network it settled on.

  // Cache quotes per session so the challenge + signed retry settle the same amount. A quote is
  // only valid for one tick exchange; if an agent abandons a challenge (or a settle fails without
  // its hook firing) the stale quote must NOT be reused for the next tick — that would bill the old
  // elapsed window and skew the session clock. We expire quotes older than QUOTE_TTL_MS so the next
  // tick always re-quotes fresh wall-clock time.
  //
  // A buyer who settles its own payment needs the quote to stay put while its transaction executes
  // (about 5 to 15 s, a minute at worst), so with buyer-settle on offer a quote lives longer. Billing
  // is unaffected: a tick bills up to the moment it was quoted, and the time spent paying falls
  // into the next tick.
  const QUOTE_TTL_MS = buyerSettle.size ? 180_000 : 30_000;
  const PAYMENT_WINDOW_S = QUOTE_TTL_MS / 1000;
  /** A quote plus its nonce: the nonce ties one buyer-settled transaction to this one tick. */
  type Pending = { quote: TickQuote; nonce: string };
  const pending = new Map<string, Pending>();

  const freshPending = (sessionId: string): Pending | undefined => {
    const p = pending.get(sessionId);
    if (p && Date.now() - p.quote.at > QUOTE_TTL_MS) {
      pending.delete(sessionId);
      return undefined;
    }
    return p;
  };

  const resourceServer = new x402ResourceServer(facilitators);
  for (const n of cfg.networks) {
    if (sponsored.has(n.id)) resourceServer.register(n.id as Network, casperScheme);
    if (buyerSettle.has(n.id)) resourceServer.register(n.id as Network, buyerScheme as never);
  }
  resourceServer
    .onAfterSettle(async (sctx: any) => {
      const sessionId = sessionIdFrom(sctx?.transportContext?.request);
      if (!sessionId) return;
      // No expiry check here: this settlement matched the session's live quote when its request
      // arrived, and a buyer-settled tick can take a while to verify. Expiring the quote now would
      // drop a tick that was paid for and delivered.
      const quote = pending.get(sessionId)?.quote;
      if (!quote) return;
      pending.delete(sessionId);

      // The hook fires whenever the facilitator ANSWERS the settle call, including when that
      // answer reports an on-chain failure. A reverted transfer still carries a transaction hash
      // (the hash of the reverted deploy), so the hash alone proves nothing. Commit only on an
      // explicit success, or the proof feed would record settlements the ledger never made.
      const result = sctx.result;
      const txHash: string = result?.transaction ?? "";
      if (result?.success !== true) {
        const why = result?.errorMessage || result?.errorReason || "settlement did not succeed";
        meter.halt(sessionId, `settlement failed: ${why}`);
        return;
      }

      // The network the buyer chose, from the settle answer or the requirements it settled against.
      const network: string = result?.network || sctx?.requirements?.network || cfg.networks[0].id;
      meter.commitTick(quote, {
        txHash,
        network,
        explorerUrl: explorerTxUrl(network, txHash),
      });
    })
    .onSettleFailure(async (sctx: any) => {
      const sessionId = sessionIdFrom(sctx?.transportContext?.request);
      if (sessionId) {
        pending.delete(sessionId);
        meter.halt(sessionId, sctx?.error?.message || "settlement failed");
      }
    });

  // DynamicPayTo: route each tick to the payee of the stream the session is consuming, so each
  // provider is paid at its own on-chain account (a real multi-party economy, not one treasury).
  const payTo = (ctx: any): string => meter.streamOf(sessionIdFrom(ctx))?.payTo ?? cfg.payTo;

  // DynamicPrice: quote the tick (stable across challenge + retry). One quote per tick, whichever
  // network pays it; each network's offer names that network's token.
  const quoteFor = (ctx: any): Pending => {
    const sessionId = sessionIdFrom(ctx);
    if (!sessionId) throw new MeterError(400, "missing ?session=");
    let p = freshPending(sessionId);
    if (!p) {
      p = { quote: meter.quoteTick(sessionId), nonce: randomBytes(32).toString("hex") };
      pending.set(sessionId, p);
    }
    return p;
  };
  const priceOn = (assetPackage: string) => (ctx: any): AssetAmount => ({ asset: assetPackage, amount: quoteFor(ctx).quote.amount, extra: tokenExtra });
  // The buyer must sign its authorization with this quote's nonce, so its transaction can pay this tick only.
  const buyerPriceOn = (assetPackage: string) => (ctx: any): AssetAmount => {
    const p = quoteFor(ctx);
    return { asset: assetPackage, amount: p.quote.amount, extra: { ...tokenExtra, nonce: p.nonce } };
  };

  app.use(
    paymentMiddleware(
      {
        "POST /tick": {
          // Network order as configured (default first). Within a network the sponsored offer comes
          // first, so existing "exact" clients see exactly what they saw before.
          accepts: cfg.networks.flatMap((n) => [
            ...(sponsored.has(n.id) ? [{ scheme: "exact", price: priceOn(n.assetPackage), network: n.id as Network, payTo }] : []),
            ...(buyerSettle.has(n.id) ? [{ scheme: SCHEME_BUYER_SETTLE, price: buyerPriceOn(n.assetPackage), network: n.id as Network, payTo, maxTimeoutSeconds: PAYMENT_WINDOW_S }] : []),
          ]),
          description: "One metered tick of a Sluice stream",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  // Runs after the middleware has verified payment. Settlement + commit happen just after this in
  // onAfterSettle; the agent reads the real tx hash from the PAYMENT-RESPONSE header.
  app.post("/tick", async (req: Request, res: Response) => {
    const sessionId = sessionIdFrom({ getQueryParam: (n) => req.query[n] as string });
    try {
      if (!sessionId) throw new MeterError(400, "missing ?session=");
      // The quote this paid request matched (still held: it is only cleared once settled).
      const quote = pending.get(sessionId)?.quote ?? meter.quoteTick(sessionId);
      const data = await nextChunk(quote.session.streamId, quote.session.ticks + 1);
      // Settlement runs after this handler and commits the tick in onAfterSettle, so report the
      // session as it reads once this tick is paid. If settlement fails, the payment middleware
      // answers 402 instead of this body.
      const payload: Partial<TickResponse> = { session: meter.sessionAfter(quote), data };
      res.json(payload);
    } catch (err) {
      if (err instanceof MeterError) res.status(err.status).json({ error: err.message });
      else res.status(500).json({ error: (err as Error).message });
    }
  });
}
