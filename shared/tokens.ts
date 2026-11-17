/**
 * The CEP-18 tokens Sluice can be paid in, and what a payment needs to know about each.
 *
 * Both kinds implement the x402 `transfer_with_authorization` entry point, signed over the same
 * EIP-712 message, but they name the amount argument differently: the reference Casper X402 token
 * reads `amount`, Odra's Wrapped CSPR (the WCSPR that CSPR.trade uses) reads `value`. Getting it
 * wrong makes every transfer revert, so it is looked up by package, never guessed.
 *
 * WCSPR is what customers pay with on mainnet: anyone can buy CSPR and wrap it 1:1, so nobody
 * depends on Sluice handing out tokens.
 */

/** Official Wrapped CSPR on Casper mainnet (CSPR.trade). Checked on chain: name "Wrapped CSPR", chain "casper:casper". */
export const WCSPR_MAINNET = "8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6";
/** Wrapped CSPR on Casper testnet (same Odra contract; the one Pico prices in). */
export const WCSPR_TESTNET = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";

export type AmountArg = "amount" | "value";

export interface TokenProfile {
  /** EIP-712 domain name: must equal the token contract's stored name. */
  name: string;
  symbol: string;
  /** EIP-712 domain version. */
  version: string;
  decimals: number;
  /** The amount argument of the token's transfer_with_authorization. */
  amountArg: AmountArg;
}

const WCSPR: TokenProfile = { name: "Wrapped CSPR", symbol: "WCSPR", version: "1", decimals: 9, amountArg: "value" };

/** The profile of a token package: WCSPR when it is a known WCSPR, otherwise the reference X402 token named `fallbackName`. */
export function tokenProfile(assetPackage: string, fallbackName: string): TokenProfile {
  const pkg = assetPackage.trim().toLowerCase().replace(/^hash-/, "");
  if (pkg === WCSPR_MAINNET || pkg === WCSPR_TESTNET) return WCSPR;
  return { name: fallbackName, symbol: "X402", version: "1", decimals: 9, amountArg: "amount" };
}

export const isAmountArg = (v: unknown): v is AmountArg => v === "amount" || v === "value";
