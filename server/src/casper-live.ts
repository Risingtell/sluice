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
 */
import type { Express, Request, Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/server";
import { HTTPFacilitatorClient, type FacilitatorConfig } from "@x402/core/server";
import type { AssetAmount, Network } from "@x402/core/types";
import type { ServerConfig } from "./config.ts";
import { StreamingMeter, MeterError, type TickQuote } from "./meter.ts";
import { nextChunk } from "./feed.ts";
import type { TickResponse } from "../../shared/types.ts";

interface HTTPReqCtx {
  path: string;
  getQueryParam?: (name: string) => string | string[] | undefined;
  adapter?: { getQueryParam?: (name: string) => string | string[] | undefined };
}

function sessionIdFrom(ctx: { getQueryParam?: HTTPReqCtx["getQueryParam"]; adapter?: HTTPReqCtx["adapter"] } | undefined): string | undefined {
  const q = ctx?.getQueryParam?.("session") ?? ctx?.adapter?.getQueryParam?.("session");
  return Array.isArray(q) ? q[0] : q;
}

export function mountCasperLive(app: Express, cfg: ServerConfig, meter: StreamingMeter): void {
  if (!cfg.facilitatorApiKey) throw new Error("LIVE mode requires FACILITATOR_API_KEY");
  if (!cfg.assetPackage) throw new Error("LIVE mode requires ASSET_PACKAGE");

  const chainID = cfg.network as Network;
  const assetPackage = cfg.assetPackage.replace(/^hash-/, "");

  // Facilitator client — raw `Authorization: <key>` on every facilitator call (verified format).
  const auth = { Authorization: cfg.facilitatorApiKey };
  const facilitatorConfig: FacilitatorConfig = {
    url: cfg.facilitatorUrl,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth, bazaar: auth }),
  };
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

  // EIP-712 domain fields must match the deployed token exactly.
  const tokenExtra = { name: cfg.assetName, symbol: "X402", version: "1", decimals: "9" };
  const casperScheme = new ExactCasperScheme()
    .registerAsset(chainID, assetPackage, 9)
    .registerMoneyParser(() =>
      Promise.resolve({ asset: assetPackage, amount: "0", extra: tokenExtra } as AssetAmount),
    );

  // Cache quotes per session so the challenge + signed retry settle the same amount. A quote is
  // only valid for one tick exchange; if an agent abandons a challenge (or a settle fails without
  // its hook firing) the stale quote must NOT be reused for the next tick — that would bill the old
  // elapsed window and skew the session clock. We expire quotes older than QUOTE_TTL_MS so the next
  // tick always re-quotes fresh wall-clock time.
  const QUOTE_TTL_MS = 30_000;
  const pending = new Map<string, TickQuote>();

  const freshPending = (sessionId: string): TickQuote | undefined => {
    const q = pending.get(sessionId);
    if (q && Date.now() - q.at > QUOTE_TTL_MS) {
      pending.delete(sessionId);
      return undefined;
    }
    return q;
  };

  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(chainID, casperScheme)
    .onAfterSettle(async (sctx: any) => {
      const sessionId = sessionIdFrom(sctx?.transportContext?.request);
      if (!sessionId) return;
      const quote = freshPending(sessionId);
      if (!quote) return;
      pending.delete(sessionId);
      const txHash: string = sctx.result?.transaction ?? "";
      meter.commitTick(quote, {
        txHash,
        network: chainID,
        explorerUrl: txHash ? `https://testnet.cspr.live/deploy/${txHash}` : "",
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

  // DynamicPrice: quote the tick (stable across challenge + retry).
  const price = (ctx: any): AssetAmount => {
    const sessionId = sessionIdFrom(ctx);
    if (!sessionId) throw new MeterError(400, "missing ?session=");
    let quote = freshPending(sessionId);
    if (!quote) {
      quote = meter.quoteTick(sessionId);
      pending.set(sessionId, quote);
    }
    return { asset: assetPackage, amount: quote.amount, extra: tokenExtra };
  };

  app.use(
    paymentMiddleware(
      {
        "POST /tick": {
          accepts: [{ scheme: "exact", price, network: chainID, payTo }],
          description: "One metered tick of a Sluice stream",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  // Runs after the middleware has verified payment. Settlement + commit happen just after this in
  // onAfterSettle; the agent reads the real tx hash from the PAYMENT-RESPONSE header.
  app.post("/tick", (req: Request, res: Response) => {
    const sessionId = sessionIdFrom({ getQueryParam: (n) => req.query[n] as string });
    try {
      if (!sessionId) throw new MeterError(400, "missing ?session=");
      const quote = freshPending(sessionId) ?? meter.quoteTick(sessionId);
      const data = nextChunk(quote.session.streamId, quote.session.ticks + 1);
      // settlement is recorded server-side via onAfterSettle; expose the pending tick + data here.
      const payload: Partial<TickResponse> = { session: quote.session, data };
      res.json(payload);
    } catch (err) {
      if (err instanceof MeterError) res.status(err.status).json({ error: err.message });
      else res.status(500).json({ error: (err as Error).message });
    }
  });
}
