/**
 * Wrap and unwrap CSPR, so a customer can turn the CSPR they bought into the WCSPR that mainnet
 * Sluice servers are paid in, and back. The agent's own account pays for everything here.
 *
 * Wrapping calls WCSPR's payable `deposit`. Casper only lets session code attach CSPR to a contract
 * call, so it runs Odra's proxy caller (sdk/wasm, MIT, unmodified). Unwrapping is a plain call to
 * `withdraw`.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainNameFor, rpcFor } from "../shared/networks.ts";
import { WCSPR_MAINNET, WCSPR_TESTNET } from "../shared/tokens.ts";
import { casperRpc, readExecution } from "../shared/buyer-settle.ts";

export const wcsprFor = (network: string): string => {
  if (network === "casper:casper") return WCSPR_MAINNET;
  if (network === "casper:casper-test") return WCSPR_TESTNET;
  throw new Error(`no known WCSPR on ${network}`);
};

/** The proxy wasm, next to the source (sdk/wasm) or the published bundle (dist/../wasm). */
function proxyWasm(): Uint8Array {
  for (const rel of ["./wasm/odra-proxy-caller-with-return.wasm", "../wasm/odra-proxy-caller-with-return.wasm"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return Uint8Array.from(readFileSync(p));
  }
  throw new Error("odra-proxy-caller-with-return.wasm not found next to the SDK");
}

export interface WrapResult {
  transactionHash: string;
  /** Gas the account paid, in motes. */
  gasMotes: bigint;
  blockHeight: number;
}

/** Wait for a legacy deploy ("Deploy") or a Casper 2.0 transaction ("Version1") to execute. */
async function waitExecuted(rpcUrl: string, kind: "Deploy" | "Version1", hash: string, waitMs: number): Promise<WrapResult> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const r = await casperRpc(rpcUrl, "info_get_transaction", { transaction_hash: { [kind]: hash } });
      const er = readExecution(r?.execution_info?.execution_result);
      if (er) {
        if (er.error) throw Object.assign(new Error(`failed on chain: ${er.error} (${hash})`), { final: true });
        return { transactionHash: hash, gasMotes: er.gasMotes, blockHeight: Number(r.execution_info.block_height ?? 0) };
      }
    } catch (err) {
      if ((err as { final?: boolean }).final) throw err;
    }
    if (Date.now() > deadline) throw new Error(`not executed after ${Math.round(waitMs / 1000)} s; it may still execute (${hash})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export interface WrapOptions {
  network: string;
  /** Gas limit in motes (default 10 CSPR to wrap, 5 to unwrap; about 3.2 and 3.5 are used). */
  gasLimitMotes?: number;
  rpcUrl?: string;
  waitMs?: number;
}

/** Wrap `amountMotes` of the account's CSPR into WCSPR, 1:1. */
export async function wrapCspr(casperSdk: any, privateKey: any, amountMotes: bigint, opts: WrapOptions): Promise<WrapResult> {
  if (amountMotes <= 0n) throw new Error("wrap amount must be positive");
  const C = casperSdk;
  const chainName = chainNameFor(opts.network);
  const rpcUrl = opts.rpcUrl || rpcFor(opts.network);
  const args = C.Args.fromMap({
    package_hash: C.CLValue.newCLByteArray(Uint8Array.from(Buffer.from(wcsprFor(opts.network), "hex"))),
    entry_point: C.CLValue.newCLString("deposit"),
    // deposit takes no arguments: its serialized RuntimeArgs are a zero u32 count.
    args: C.CLValue.newCLList(C.CLTypeUInt8, [0, 0, 0, 0].map((b: number) => C.CLValue.newCLUint8(b))),
    attached_value: C.CLValue.newCLUInt512(amountMotes.toString()),
    amount: C.CLValue.newCLUInt512(amountMotes.toString()),
  });
  const header = C.DeployHeader.default();
  header.account = privateKey.publicKey;
  header.chainName = chainName;
  const deploy = C.Deploy.makeDeploy(header, C.ExecutableDeployItem.standardPayment(String(opts.gasLimitMotes ?? 10_000_000_000)), C.ExecutableDeployItem.newModuleBytes(proxyWasm(), args));
  if (deploy.header.chainName !== chainName) throw new Error(`refusing: built for ${deploy.header.chainName}`);
  deploy.sign(privateKey);
  const put = await new C.RpcClient(new C.HttpHandler(rpcUrl)).putDeploy(deploy);
  const hash: string = put.deployHash?.toHex?.() ?? String(put.deployHash);
  return waitExecuted(rpcUrl, "Deploy", hash, opts.waitMs ?? 180_000);
}

/** Unwrap `amountMotes` of the account's WCSPR back into CSPR. */
export async function unwrapCspr(casperSdk: any, privateKey: any, amountMotes: bigint, opts: WrapOptions): Promise<WrapResult> {
  if (amountMotes <= 0n) throw new Error("unwrap amount must be positive");
  const C = casperSdk;
  const rpcUrl = opts.rpcUrl || rpcFor(opts.network);
  const tx = new C.ContractCallBuilder()
    .from(privateKey.publicKey)
    .byPackageHash(wcsprFor(opts.network))
    .entryPoint("withdraw")
    .runtimeArgs(C.Args.fromMap({ amount: C.CLValue.newCLUInt256(amountMotes.toString()) }))
    .chainName(chainNameFor(opts.network))
    .payment(opts.gasLimitMotes ?? 5_000_000_000)
    .build();
  tx.sign(privateKey);
  const put = await new C.RpcClient(new C.HttpHandler(rpcUrl)).putTransaction(tx);
  const hash: string = put.transactionHash.toHex();
  return waitExecuted(rpcUrl, "Version1", hash, opts.waitMs ?? 180_000);
}
