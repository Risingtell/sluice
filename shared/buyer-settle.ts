/**
 * The "buyer-settle" payment scheme: the buyer pays its own gas.
 *
 * In the standard Casper x402 "exact" scheme the buyer signs an EIP-712 authorization and the
 * server's facilitator submits the CEP-18 `transfer_with_authorization` call, paying the gas. That
 * is right for a free testnet demo and wrong for mainnet: every tick would spend the server
 * operator's CSPR on someone else's payment.
 *
 * In buyer-settle the buyer signs the same authorization, submits that same call from its OWN
 * account (so its account pays the gas), waits for the transaction to execute, and then sends the
 * transaction hash with the authorization. The server never submits anything; it only reads the
 * chain and accepts the payment if the executed transaction is exactly the one it asked for.
 *
 * What binds a transaction to one tick: the server puts a fresh random 32-byte nonce in each quote
 * (`extra.nonce`) and the buyer must sign the authorization with it. The token contract refuses a
 * nonce it has seen before, so one on-chain payment can satisfy one quote, and nobody can claim a
 * payment they did not make for their own session: they never received that quote's nonce.
 *
 * This file is shared by the server (which checks) and the SDK (which pays, then checks its own
 * transaction the same way before handing the hash over).
 */

export const SCHEME_BUYER_SETTLE = "buyer-settle";

/** The CEP-18 entry point both schemes call. */
export const TRANSFER_ENTRY_POINT = "transfer_with_authorization";

/** Gas limit a buyer attaches to its own transfer, in motes. One costs about 3.3 CSPR net. */
export const DEFAULT_GAS_LIMIT_MOTES = 5_000_000_000;

/** What the server asked for, and so what the executed transaction must contain. */
export interface SettlementExpectation {
  /** CEP-18 contract package hash, 64 hex, no prefix. */
  asset: string;
  /** Payee: "00" + 64-hex account hash, the x402 address form. */
  payTo: string;
  /** Token amount in the smallest unit, decimal string. */
  amount: string;
  /** The quote's 32-byte nonce, 64 hex. */
  nonce: string;
  /** Casper chain name: "casper" or "casper-test". */
  chainName: string;
  /** The token's amount argument: "amount" (reference X402 token, default) or "value" (WCSPR). */
  amountArg?: "amount" | "value";
}

export type SettlementCheck =
  | {
      ok: true;
      /** The paying account, "00" + account hash. */
      payer: string;
      /** The account that submitted (and paid gas for) the transaction, as the node reports it. */
      initiator: string;
      /** Gas the initiator paid, in motes (cost minus refund). */
      gasMotes: string;
      blockHeight: number;
    }
  | {
      ok: false;
      /** True while the transaction is not executed yet: worth asking again shortly. */
      pending: boolean;
      reason: string;
      /** Gas the initiator paid, when the transaction executed (and failed); unknown otherwise. */
      gasMotes?: string;
    };

const HEX64 = /^[0-9a-f]{64}$/;
export const isHex64 = (s: unknown): s is string => typeof s === "string" && HEX64.test(s);
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** A List<U8> of 32 bytes serialises as a u32 little-endian length (0x20) followed by the bytes. */
const listU8Bytes32 = (hex: string) => "20000000" + hex;

/**
 * Checks an `info_get_transaction` result against what the server asked for. Pure, so it can be
 * tested against real transactions offline. Every field that decides who got paid how much is
 * compared exactly; the EIP-712 signature itself is not re-checked here because the token contract
 * verified it on chain, and a transaction that executed without error passed that check.
 */
export function checkSettlement(result: any, expect: SettlementExpectation): SettlementCheck {
  const fail = (reason: string, pending = false): SettlementCheck => ({ ok: false, pending, reason });
  const tx = result?.transaction?.Version1;
  if (!tx) return fail("not a Casper 2.0 Version1 transaction");
  const payload = tx.payload ?? {};
  const fields = payload.fields ?? {};

  if (lc(payload.chain_name) !== lc(expect.chainName)) return fail(`transaction is on ${payload.chain_name}, expected ${expect.chainName}`);

  const target = fields.target?.Stored?.id?.ByPackageHash?.addr;
  if (lc(target) !== lc(expect.asset).replace(/^hash-/, "")) return fail("transaction does not call the payment token's contract package");
  if (fields.entry_point?.Custom !== TRANSFER_ENTRY_POINT) return fail(`transaction does not call ${TRANSFER_ENTRY_POINT}`);

  const named: [string, any][] = Array.isArray(fields.args?.Named) ? fields.args.Named : [];
  const arg = (name: string) => named.find(([n]) => n === name)?.[1];
  const to = lc(arg("to")?.parsed);
  const from = lc(arg("from")?.parsed);
  const amount = String(arg(expect.amountArg ?? "amount")?.parsed ?? "");
  const nonce = lc(arg("nonce")?.bytes);

  if (!isHex64(lc(expect.payTo).slice(2))) return fail("expected payee is not an account address");
  if (to !== `account-hash-${lc(expect.payTo).slice(2)}`) return fail("transaction pays a different account");
  if (amount !== String(expect.amount)) return fail(`transaction moves ${amount || "nothing"}, the tick costs ${expect.amount}`);
  if (!isHex64(lc(expect.nonce)) || nonce !== listU8Bytes32(lc(expect.nonce))) return fail("transaction was not signed for this tick (nonce differs)");
  if (!from.startsWith("account-hash-") || !isHex64(from.slice("account-hash-".length))) return fail("transaction has no paying account");

  const exec = result?.execution_info;
  const er = exec?.execution_result?.Version2 ?? exec?.execution_result?.Version1;
  if (!exec || !er) return fail("transaction not executed yet", true);

  let gasMotes = "0";
  try {
    gasMotes = (BigInt(er.cost ?? 0) - BigInt(er.refund ?? 0)).toString();
  } catch {
    /* a node that omits cost or refund still executed the transaction; gas stays unreported */
  }
  if (er.error_message) return { ok: false, pending: false, reason: `transaction failed on chain: ${er.error_message}`, gasMotes };
  const initiator = payload.initiator_addr?.PublicKey ?? payload.initiator_addr?.AccountHash ?? "";
  return { ok: true, payer: "00" + from.slice("account-hash-".length), initiator: String(initiator), gasMotes, blockHeight: Number(exec.block_height ?? 0) };
}

/**
 * What the buyer signs, with the key that paid, to claim its transfer for this tick. The transfer's
 * own arguments (authorization signature included) are public on chain the moment it executes, so
 * they prove nothing about who is asking; this signature is never on chain, so only the holder of
 * the paying key can produce it.
 */
export const claimMessage = (network: string, nonce: string, transactionHash: string): Uint8Array =>
  new TextEncoder().encode(`sluice-buyer-settle|${network}|${lc(nonce)}|${lc(transactionHash)}`);

/** One JSON-RPC call to a Casper node. */
export async function casperRpc(rpcUrl: string, method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string; data?: unknown } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "error"}${body.error.data ? ` (${JSON.stringify(body.error.data).slice(0, 120)})` : ""}`);
  return body.result;
}

/**
 * Reads a transaction until it has executed (or the wait runs out) and checks it. A node that has
 * not seen the transaction yet, or a failed RPC call, counts as pending: the transaction may still
 * be propagating. Anything that contradicts the expectation fails at once.
 */
export async function confirmSettlement(
  rpcUrl: string,
  transactionHash: string,
  expect: SettlementExpectation,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<SettlementCheck> {
  if (!isHex64(lc(transactionHash))) return { ok: false, pending: false, reason: "transactionHash must be 64 hex characters" };
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const deadline = Date.now() + waitMs;
  let last: SettlementCheck = { ok: false, pending: true, reason: "transaction not found yet" };
  for (;;) {
    try {
      const result = await casperRpc(rpcUrl, "info_get_transaction", { transaction_hash: { Version1: lc(transactionHash) } });
      last = checkSettlement(result, expect);
      if (!last.ok && !last.pending) return last;
      if (last.ok) return last;
    } catch (err) {
      last = { ok: false, pending: true, reason: `transaction not readable yet (${(err as Error).message.slice(0, 100)})` };
    }
    if (Date.now() + pollMs > deadline) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
