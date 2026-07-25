/**
 * X402 token faucet: lets any agent onboard itself.
 *
 * Sluice's whole claim is that an autonomous agent can rent a metered resource and pay for it. That
 * was only half true while the CEP-18 X402 token existed solely in our own accounts: a third-party
 * agent could discover streams, open a session and speak the protocol correctly, then hit a 402 it
 * had no means to satisfy. This route closes that gap. Point an agent at it, get tokens, stream.
 *
 * It moves real value and spends real gas, so it is bounded on three axes:
 *   - one grant per recipient address, ever (this is a demo faucet, not a supply)
 *   - a per-IP daily cap
 *   - a global daily cap, so total gas exposure per day is knowable in advance
 * It also refuses to serve when the fee payer's CSPR is low, rather than emitting failing deploys.
 *
 * Requests are serialized: two concurrent CEP-18 transfers from the same account race on the
 * account's nonce, and the loser fails on-chain after spending gas.
 */
import type { Express, Request, Response } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerConfig } from "./config.ts";

const STATE_FILE = process.env.FAUCET_STATE_PATH || "server/.data/faucet.json";

/** Base units granted per request. 9 decimals, so this is 0.1 X402: several full sessions. */
const GRANT = BigInt(process.env.FAUCET_GRANT_UNITS || "100000000");
const PER_IP_PER_DAY = parseInt(process.env.FAUCET_PER_IP_PER_DAY || "3", 10);
const GLOBAL_PER_DAY = parseInt(process.env.FAUCET_GLOBAL_PER_DAY || "40", 10);
/** Gas ceiling per transfer, in motes. Refuse to serve below this much headroom. */
const GAS_MOTES = parseInt(process.env.FAUCET_GAS_MOTES || "5000000000", 10);
const MIN_CSPR_MOTES = BigInt(GAS_MOTES) * 4n;

interface FaucetState {
  day: string;
  globalToday: number;
  perIpToday: Record<string, number>;
  /** Every address ever served, so a grant cannot be farmed by cycling IPs. */
  served: Record<string, { at: number; txHash: string }>;
}

const todayUTC = () => new Date().toISOString().slice(0, 10);

function readState(): FaucetState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as FaucetState;
    if (s.day === todayUTC()) return s;
    // New UTC day: reset the daily counters, keep the permanent served list.
    return { day: todayUTC(), globalToday: 0, perIpToday: {}, served: s.served ?? {} };
  } catch {
    return { day: todayUTC(), globalToday: 0, perIpToday: {}, served: {} };
  }
}

function writeState(s: FaucetState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {}
}

/**
 * Normalize any of the accepted address spellings to a bare 64-hex account hash.
 * Accepts "00<64hex>" (the x402 address form), "account-hash-<64hex>", or bare 64 hex.
 */
export function normalizeAccountHash(input: string): string | undefined {
  const v = String(input || "").trim().toLowerCase().replace(/^account-hash-/, "");
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  if (/^00[0-9a-f]{64}$/.test(v)) return v.slice(2);
  return undefined;
}

export function mountFaucet(app: Express, cfg: ServerConfig): void {
  const explorerBase = cfg.network === "casper:casper" ? "https://cspr.live" : "https://testnet.cspr.live";
  let inFlight: Promise<unknown> = Promise.resolve();

  app.get("/faucet", (_req, res) => {
    const s = readState();
    res.json({
      asset: cfg.assetName,
      assetPackage: cfg.assetPackage,
      network: cfg.network,
      grantUnits: GRANT.toString(),
      grant: `${Number(GRANT) / 1e9} ${cfg.assetName}`,
      remainingToday: Math.max(0, GLOBAL_PER_DAY - s.globalToday),
      oneGrantPerAddress: true,
      usage: 'POST /faucet {"address":"00<64 hex account hash>"}',
    });
  });

  app.post("/faucet", async (req: Request, res: Response) => {
    const address = normalizeAccountHash((req.body as { address?: string })?.address ?? "");
    if (!address) {
      return res.status(400).json({
        error: 'address must be a Casper account hash: "00" + 64 hex, "account-hash-<64 hex>", or bare 64 hex',
      });
    }

    const ip = String(req.ip || req.socket.remoteAddress || "unknown");
    const state = readState();

    if (state.served[address]) {
      const prior = state.served[address];
      return res.status(429).json({
        error: "this address already received a grant",
        grantedAt: prior.at,
        txHash: prior.txHash,
        explorerUrl: prior.txHash ? `${explorerBase}/deploy/${prior.txHash}` : undefined,
      });
    }
    if ((state.perIpToday[ip] ?? 0) >= PER_IP_PER_DAY) {
      return res.status(429).json({ error: `daily limit reached for this client (${PER_IP_PER_DAY} per day)` });
    }
    if (state.globalToday >= GLOBAL_PER_DAY) {
      return res.status(429).json({ error: "the faucet's daily budget is spent; it resets at 00:00 UTC" });
    }

    // Serialize: concurrent transfers from one account race on its nonce.
    const run = inFlight.then(() => grant(address, ip));
    inFlight = run.catch(() => undefined);
    try {
      const out = await run;
      res.json(out);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /** Send one grant on-chain and record it. Throws with a plain reason on failure. */
  async function grant(address: string, ip: string): Promise<Record<string, unknown>> {
    const casperMod = await import("casper-js-sdk");
    const sdk = (casperMod as any).default ?? casperMod;
    const { Args, CLValue, Key, PrivateKey, KeyAlgorithm, RpcClient, HttpHandler, PurseIdentifier } = sdk;

    const keyPath = process.env.CLIENT_PRIVATE_KEY_PATH || "keys/agent.pem";
    if (!existsSync(keyPath)) throw new Error("faucet is not configured on this deployment");
    const holder = PrivateKey.fromPem(readFileSync(keyPath, "utf8"), KeyAlgorithm.ED25519);

    const rpcUrl =
      process.env.FACILITATOR_RPC_URL ||
      (cfg.network === "casper:casper"
        ? "https://node.mainnet.casper.network/rpc"
        : "https://node.testnet.casper.network/rpc");
    const client = new RpcClient(new HttpHandler(rpcUrl));

    // Refuse rather than emit a deploy we cannot pay for.
    const blk: any = await client.getLatestBlock();
    const bal: any = await client.queryBalanceByBlockHeight(
      PurseIdentifier.fromPublicKey(holder.publicKey),
      blk.block.height,
    );
    if (BigInt((bal.balance ?? "0").toString()) < MIN_CSPR_MOTES) {
      throw new Error("the faucet is temporarily out of gas; try again later");
    }

    const tx = new sdk.ContractCallBuilder()
      .from(holder.publicKey)
      .chainName(cfg.network === "casper:casper" ? "casper" : "casper-test")
      .byPackageHash(String(cfg.assetPackage).replace(/^hash-/, ""))
      .entryPoint("transfer")
      .runtimeArgs(
        Args.fromMap({
          recipient: CLValue.newCLKey(Key.newKey(`account-hash-${address}`)),
          amount: CLValue.newCLUInt256(GRANT.toString()),
        }),
      )
      .payment(GAS_MOTES)
      .build();
    tx.sign(holder);

    const submitted: any = await client.putTransaction(tx);
    const txHash: string = submitted.transactionHash.toHex();

    const s = readState();
    s.globalToday += 1;
    s.perIpToday[ip] = (s.perIpToday[ip] ?? 0) + 1;
    s.served[address] = { at: Date.now(), txHash };
    writeState(s);

    return {
      ok: true,
      address,
      amount: GRANT.toString(),
      asset: cfg.assetName,
      network: cfg.network,
      txHash,
      explorerUrl: `${explorerBase}/deploy/${txHash}`,
      note: "settlement finalizes in a few seconds; then open a session and pay a tick",
    };
  }
}
