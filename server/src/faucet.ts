/**
 * X402 token faucet: lets any agent onboard itself.
 *
 * Sluice's whole claim is that an autonomous agent can rent a metered resource and pay for it. That
 * was only half true while the CEP-18 X402 token existed solely in our own accounts: a third-party
 * agent could discover streams, open a session and speak the protocol correctly, then hit a 402 it
 * had no means to satisfy. This route closes that gap. Point an agent at it, get tokens, stream.
 *
 * It moves real value and spends real gas, so it is bounded on three axes, per network:
 *   - one grant per recipient address, ever (this is a demo faucet, not a supply)
 *   - a per-IP daily cap
 *   - a global daily cap, so total gas exposure per day is knowable in advance
 * Mainnet gets tighter caps than testnet: every mainnet grant spends about 3.3 CSPR of real gas.
 * It also refuses to serve when the fee payer's CSPR is low, rather than emitting failing deploys.
 *
 * Requests are serialized: two concurrent CEP-18 transfers from the same account race on the
 * account's nonce, and the loser fails on-chain after spending gas.
 */
import type { Express, Request, Response } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerConfig } from "./config.ts";
import { MAINNET, TESTNET, chainNameFor, explorerFor, labelFor, rpcFor, rpcOverride } from "../../shared/networks.ts";

/** One state file per network; testnet keeps the file it always had. */
const TESTNET_STATE = process.env.FAUCET_STATE_PATH || "server/.data/faucet.json";
const stateFileFor = (network: string) => (network === MAINNET ? process.env.FAUCET_MAINNET_STATE_PATH || "server/.data/faucet.mainnet.json" : TESTNET_STATE);

/** Base units granted per request. 9 decimals, so this is 0.1 X402: several full sessions. */
const GRANT = BigInt(process.env.FAUCET_GRANT_UNITS || "100000000");
const LIMITS: Record<string, { perIp: number; global: number }> = {
  [MAINNET]: {
    perIp: parseInt(process.env.FAUCET_MAINNET_PER_IP_PER_DAY || "1", 10),
    global: parseInt(process.env.FAUCET_MAINNET_GLOBAL_PER_DAY || "10", 10),
  },
  [TESTNET]: {
    perIp: parseInt(process.env.FAUCET_PER_IP_PER_DAY || "3", 10),
    global: parseInt(process.env.FAUCET_GLOBAL_PER_DAY || "40", 10),
  },
};
const limitsFor = (network: string) => LIMITS[network] ?? LIMITS[TESTNET];
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

function readState(network: string): FaucetState {
  try {
    const s = JSON.parse(readFileSync(stateFileFor(network), "utf8")) as FaucetState;
    if (s.day === todayUTC()) return s;
    // New UTC day: reset the daily counters, keep the permanent served list.
    return { day: todayUTC(), globalToday: 0, perIpToday: {}, served: s.served ?? {} };
  } catch {
    return { day: todayUTC(), globalToday: 0, perIpToday: {}, served: {} };
  }
}

function writeState(network: string, s: FaucetState): void {
  const file = stateFileFor(network);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s));
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
  let inFlight: Promise<unknown> = Promise.resolve();
  // Every network the server settles on, default (mainnet) first.
  const networks = cfg.networks.filter((n) => n.assetPackage);
  const specOf = (network: string) => networks.find((n) => n.id === network);

  const describe = (n: (typeof networks)[number]) => ({
    network: n.id,
    label: labelFor(n.id),
    assetPackage: n.assetPackage,
    remainingToday: Math.max(0, limitsFor(n.id).global - readState(n.id).globalToday),
    perClientPerDay: limitsFor(n.id).perIp,
  });

  /**
   * Why a grant must be refused, or undefined. Checked once before queueing (a quick answer) and
   * again inside the queue, where only one grant runs at a time: a burst of parallel requests all
   * pass the first check before any grant is recorded, so only the second one keeps the caps exact.
   */
  const refusal = (network: string, address: string, ip: string): Record<string, unknown> | undefined => {
    const state = readState(network);
    const limits = limitsFor(network);
    const prior = state.served[address];
    if (prior) {
      return {
        error: `this address already received a grant on ${labelFor(network)}`,
        grantedAt: prior.at,
        txHash: prior.txHash,
        explorerUrl: prior.txHash ? `${explorerFor(network)}/deploy/${prior.txHash}` : undefined,
      };
    }
    if ((state.perIpToday[ip] ?? 0) >= limits.perIp) return { error: `daily limit reached for this client on ${labelFor(network)} (${limits.perIp} per day)` };
    if (state.globalToday >= limits.global) return { error: `the faucet's daily budget on ${labelFor(network)} is spent; it resets at 00:00 UTC` };
    return undefined;
  };

  app.get("/faucet", (_req, res) => {
    const listed = networks.map(describe);
    res.json({
      asset: cfg.assetName,
      // The default network's figures, as before; every network is listed under `networks`.
      assetPackage: listed[0]?.assetPackage ?? "",
      network: listed[0]?.network ?? cfg.network,
      networks: listed,
      grantUnits: GRANT.toString(),
      grant: `${Number(GRANT) / 1e9} ${cfg.assetName}`,
      remainingToday: listed[0]?.remainingToday ?? 0,
      oneGrantPerAddress: true,
      usage: `POST /faucet {"address":"00<64 hex account hash>","network":"${listed[0]?.network ?? MAINNET}"}; network is optional and defaults to ${listed[0] ? listed[0].label : "the first network"}`,
    });
  });

  app.post("/faucet", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { address?: string; network?: string };
    const address = normalizeAccountHash(body.address ?? "");
    if (!address) {
      return res.status(400).json({
        error: 'address must be a Casper account hash: "00" + 64 hex, "account-hash-<64 hex>", or bare 64 hex',
      });
    }
    const network = String(body.network || networks[0]?.id || "");
    const spec = specOf(network);
    if (!spec) {
      return res.status(400).json({ error: `network must be one of ${networks.map((n) => n.id).join(", ")}` });
    }
    const ip = String(req.ip || req.socket.remoteAddress || "unknown");
    const early = refusal(network, address, ip);
    if (early) return res.status(429).json(early);

    // Serialize: concurrent transfers from one account race on its nonce. Inside the queue the
    // limits are checked again, against every grant recorded before this one.
    const run = inFlight.then(() => {
      const late = refusal(network, address, ip);
      return late ? { refused: late } : grant(address, ip, spec.id, spec.assetPackage);
    });
    inFlight = run.catch(() => undefined);
    try {
      const out = await run;
      if ("refused" in out) return res.status(429).json(out.refused);
      res.json(out);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /** Send one grant on-chain and record it. Throws with a plain reason on failure. */
  async function grant(address: string, ip: string, network: string, assetPackage: string): Promise<Record<string, unknown>> {
    const casperMod = await import("casper-js-sdk");
    const sdk = (casperMod as any).default ?? casperMod;
    const { Args, CLValue, Key, PrivateKey, KeyAlgorithm, RpcClient, HttpHandler, PurseIdentifier } = sdk;

    const keyPath = process.env.CLIENT_PRIVATE_KEY_PATH || "keys/agent.pem";
    if (!existsSync(keyPath)) throw new Error("faucet is not configured on this deployment");
    const holder = PrivateKey.fromPem(readFileSync(keyPath, "utf8"), KeyAlgorithm.ED25519);

    // The same RPC overrides as the facilitator: per network, or FACILITATOR_RPC_URL for a single one.
    const client = new RpcClient(new HttpHandler(rpcOverride(network, process.env, networks.length) || rpcFor(network)));
    const explorerBase = explorerFor(network);

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
      .chainName(chainNameFor(network))
      .byPackageHash(assetPackage.replace(/^hash-/, ""))
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

    const s = readState(network);
    s.globalToday += 1;
    s.perIpToday[ip] = (s.perIpToday[ip] ?? 0) + 1;
    s.served[address] = { at: Date.now(), txHash };
    writeState(network, s);

    return {
      ok: true,
      address,
      amount: GRANT.toString(),
      asset: cfg.assetName,
      network,
      txHash,
      explorerUrl: `${explorerBase}/deploy/${txHash}`,
      note: "settlement finalizes in a few seconds; then open a session and pay a tick",
    };
  }
}
