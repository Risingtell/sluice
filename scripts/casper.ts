/**
 * Thin Casper testnet helpers shared by the live scripts (balance, wrap, etc).
 */
import casperSdk from "casper-js-sdk";
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";

loadEnv();

const { KeyAlgorithm, PrivateKey, RpcClient, HttpHandler, PurseIdentifier } = casperSdk;

export const RPC_URL = process.env.RPC_URL || "https://node.testnet.casper.network/rpc";
export const CHAIN_NAME = "casper-test";

export function rpc() {
  return new RpcClient(new HttpHandler(RPC_URL));
}

export function loadAgentKey() {
  const path = process.env.CLIENT_PRIVATE_KEY_PATH || "keys/agent.pem";
  const algo = (process.env.CLIENT_KEY_ALGO || "ed25519") === "secp256k1"
    ? KeyAlgorithm.SECP256K1
    : KeyAlgorithm.ED25519;
  return PrivateKey.fromPem(readFileSync(path, "utf8"), algo);
}

/** CSPR (motes) in an account's main purse, as a bigint. */
export async function csprBalance(publicKey: InstanceType<typeof casperSdk.PublicKey>): Promise<bigint> {
  const client = rpc();
  const blk = await client.getLatestBlock();
  const height = (blk as any).block.height as number;
  const purseId = PurseIdentifier.fromPublicKey(publicKey);
  const res: any = await client.queryBalanceByBlockHeight(purseId, height);
  return BigInt((res.balance ?? "0").toString());
}

export const fmtCspr = (motes: bigint) => (Number(motes) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 5 });
