/**
 * Client side of the buyer-settle scheme (shared/buyer-settle.ts): this agent signs the transfer
 * authorization with the server's nonce, submits the CEP-18 `transfer_with_authorization` call from
 * its OWN account (paying the gas), waits for it to execute, checks it the same way the server
 * will, and only then hands the server the transaction hash, with a claim signed by the same key.
 *
 * One transfer per quote: if the server refuses a tick after the transfer executed (or the wait ran
 * out first), a retry for the same quote re-sends that same transfer instead of paying again.
 */
import {
  DEFAULT_GAS_LIMIT_MOTES,
  SCHEME_BUYER_SETTLE,
  TRANSFER_ENTRY_POINT,
  claimMessage,
  confirmSettlement,
  isHex64,
  type SettlementExpectation,
} from "../shared/buyer-settle.ts";
import { chainNameFor, explorerTxUrl, rpcFor } from "../shared/networks.ts";
import { isAmountArg, tokenProfile } from "../shared/tokens.ts";

const ADDRESS = /^00[0-9a-f]{64}$/;

const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

export interface BuyerSettleOptions {
  /** Gas limit attached to each transfer, in motes (default 5 CSPR; about 3.3 CSPR is used). */
  gasLimitMotes?: number;
  /** Casper node per network; default the public node. */
  rpcUrls?: Record<string, string>;
  /** Longest wait for a transfer to execute (default 120 s, and always inside the quote's window). */
  waitMs?: number;
}

/**
 * The gas this agent spends, transfer by transfer: every transfer it submits, including ones a
 * server refused or that failed on chain, so the totals match what left the account.
 */
export class GasTracker {
  /** All gas paid since this client was created, in motes. */
  total = 0n;
  /** Transfers submitted during the current payTick call. */
  submitted: string[] = [];
  private readonly byHash = new Map<string, bigint>();

  begin(): void {
    this.submitted = [];
  }
  noteSubmitted(hash: string): void {
    this.submitted.push(hash);
  }
  noteGas(hash: string, motes: bigint): void {
    if (this.byHash.has(hash)) return;
    this.total += motes;
    this.byHash.set(hash, motes);
    if (this.byHash.size > 64) this.byHash.delete(this.byHash.keys().next().value as string);
  }
  /** Gas of one transfer, once (then forgotten). */
  take(hash: string): bigint {
    const g = this.byHash.get(hash) ?? 0n;
    this.byHash.delete(hash);
    return g;
  }
}

type Sent = { hash: string; payload: Record<string, unknown>; confirmed: boolean; at: number };

export class BuyerSettleClientScheme {
  readonly scheme = SCHEME_BUYER_SETTLE;
  /** Transfers by quote (network + nonce), so one quote is never paid twice. */
  private readonly sent = new Map<string, Sent>();

  constructor(
    /** casper-js-sdk module (passed in so the SDK keeps loading it lazily). */
    private readonly casperSdk: any,
    /** casper-js-sdk PrivateKey of the paying agent. */
    private readonly privateKey: any,
    private readonly eip712: { buildDomain: Function; hashTypedData: Function; CASPER_DOMAIN_TYPES: unknown },
    private readonly gas: GasTracker,
    private readonly opts: BuyerSettleOptions = {},
  ) {}

  accountAddress(): string {
    return "00" + this.privateKey.publicKey.accountHash().toHex();
  }

  async createPaymentPayload(x402Version: number, req: any): Promise<{ x402Version: number; payload: Record<string, unknown> }> {
    const { casperSdk, privateKey } = this;
    const asset = String(req.asset ?? "");
    const payTo = String(req.payTo ?? "");
    const nonce = String(req.extra?.nonce ?? "").toLowerCase();
    const name = req.extra?.name;
    const version = req.extra?.version;
    if (!isHex64(asset)) throw new Error(`buyer-settle: invalid token package ${asset}`);
    if (!ADDRESS.test(payTo)) throw new Error(`buyer-settle: invalid payee ${payTo}`);
    if (!isHex64(nonce)) throw new Error("buyer-settle: the server sent no nonce for this tick");
    if (typeof name !== "string" || !name || typeof version !== "string" || !version) throw new Error("buyer-settle: token name/version missing");
    // WCSPR names the amount "value", the reference X402 token "amount". The server says which;
    // a server that does not gets the name this SDK knows for the token.
    const amountArg = req.extra?.amountArg ?? tokenProfile(asset, name).amountArg;
    if (!isAmountArg(amountArg)) throw new Error(`buyer-settle: unknown token amount argument ${amountArg}`);

    const network = String(req.network);
    const chainName = chainNameFor(network);
    const rpcUrl = this.opts.rpcUrls?.[network] || rpcFor(network);
    const expect: SettlementExpectation = { asset, payTo, amount: String(req.amount), nonce, chainName, amountArg };
    const quoteKey = `${network}|${nonce}`;
    const now = Math.floor(Date.now() / 1000);
    const windowS = Number(req.maxTimeoutSeconds || 180);
    // Finish inside the quote's window, leaving room for the server's own check.
    const waitMs = Math.max(15_000, Math.min(this.opts.waitMs ?? 120_000, (windowS - 40) * 1000));

    // This quote already has a transfer: send that one again, never a second payment.
    const earlier = this.sent.get(quoteKey);
    if (earlier) {
      if (!earlier.confirmed) {
        const check = await confirmSettlement(rpcUrl, earlier.hash, expect, { waitMs });
        if (!check.ok) {
          if (check.gasMotes) this.gas.noteGas(earlier.hash, BigInt(check.gasMotes));
          if (!check.pending) this.sent.delete(quoteKey); // it failed on chain; the nonce is unused
          throw this.failure(earlier.hash, network, check.pending, check.reason, waitMs);
        }
        this.gas.noteGas(earlier.hash, BigInt(check.gasMotes));
        earlier.confirmed = true;
      }
      return { x402Version, payload: earlier.payload };
    }

    // 1. Sign the same EIP-712 authorization the "exact" scheme uses, with the server's nonce.
    const validAfter = now - 600;
    const validBefore = now + windowS;
    const domain = this.eip712.buildDomain(name, version, network, "0x" + asset);
    const from = this.accountAddress();
    const digest = this.eip712.hashTypedData(
      domain,
      transferWithAuthorizationTypes,
      "TransferWithAuthorization",
      { from: "0x" + from, to: "0x" + payTo, value: BigInt(req.amount), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce: "0x" + nonce },
      { domainTypes: this.eip712.CASPER_DOMAIN_TYPES },
    );
    const signature: Uint8Array = await privateKey.signAndAddAlgorithmBytes(digest);

    // 2. Submit the transfer from this agent's own account: this agent pays the gas.
    const u8list = (bytes: Uint8Array) => casperSdk.CLValue.newCLList(casperSdk.CLTypeUInt8, Array.from(bytes).map((b) => casperSdk.CLValue.newCLUint8(b)));
    const args = casperSdk.Args.fromMap({
      from: casperSdk.CLValue.newCLKey(casperSdk.Key.newKey("account-hash-" + from.slice(2))),
      to: casperSdk.CLValue.newCLKey(casperSdk.Key.newKey("account-hash-" + payTo.slice(2))),
      [amountArg]: casperSdk.CLValue.newCLUInt256(String(req.amount)),
      valid_after: casperSdk.CLValue.newCLUint64(validAfter),
      valid_before: casperSdk.CLValue.newCLUint64(validBefore),
      nonce: u8list(fromHex(nonce)),
      public_key: casperSdk.CLValue.newCLPublicKey(privateKey.publicKey),
      signature: u8list(signature),
    });
    const tx = new casperSdk.ContractCallBuilder()
      .from(privateKey.publicKey)
      .byPackageHash(asset)
      .entryPoint(TRANSFER_ENTRY_POINT)
      .runtimeArgs(args)
      .chainName(chainName)
      .payment(this.opts.gasLimitMotes ?? DEFAULT_GAS_LIMIT_MOTES)
      .build();
    tx.sign(privateKey);
    const rpc = new casperSdk.RpcClient(new casperSdk.HttpHandler(rpcUrl));
    const put = await rpc.putTransaction(tx);
    const transactionHash: string = put.transactionHash.toHex();
    this.gas.noteSubmitted(transactionHash);

    // 3. The claim: proves to the server this agent is the one that paid.
    const claim: Uint8Array = await privateKey.signAndAddAlgorithmBytes(claimMessage(network, nonce, transactionHash));
    const payload = {
      transactionHash,
      publicKey: privateKey.publicKey.toHex(),
      claimSignature: toHex(claim),
      signature: toHex(signature),
      authorization: { from, to: payTo, value: String(req.amount), validAfter: String(validAfter), validBefore: String(validBefore), nonce },
    };
    const entry: Sent = { hash: transactionHash, payload, confirmed: false, at: Date.now() };
    this.remember(quoteKey, entry);

    // 4. Wait for it to execute and check it exactly as the server will, so a failed or wrong
    //    transfer stops here instead of reaching the server as a payment.
    const check = await confirmSettlement(rpcUrl, transactionHash, expect, { waitMs });
    if (!check.ok) {
      if (check.gasMotes) this.gas.noteGas(transactionHash, BigInt(check.gasMotes));
      if (!check.pending) this.sent.delete(quoteKey);
      throw this.failure(transactionHash, network, check.pending, check.reason, waitMs);
    }
    this.gas.noteGas(transactionHash, BigInt(check.gasMotes));
    entry.confirmed = true;
    return { x402Version, payload };
  }

  private failure(hash: string, network: string, pending: boolean, reason: string, waitMs: number): Error {
    const link = explorerTxUrl(network, hash);
    return pending
      ? new Error(`buyer-settle: transfer ${hash} had not executed after ${Math.round(waitMs / 1000)} s. It may still execute and move tokens; check ${link}. Paying this tick again re-sends the same transfer.`)
      : new Error(`buyer-settle: transfer ${hash} did not pay the tick: ${reason} (${link})`);
  }

  private remember(key: string, entry: Sent): void {
    this.sent.set(key, entry);
    const cutoff = Date.now() - 15 * 60_000;
    for (const [k, v] of this.sent) if (v.at < cutoff || this.sent.size > 32) this.sent.delete(k);
    this.sent.set(key, entry);
  }
}
