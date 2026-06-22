/**
 * @module @make-software/casper-x402 - x402 Payment Protocol Casper Implementation for JavaScript
 *
 * This module provides the Casper-specific client implementation of the x402 payment protocol.
 */

// Exact scheme client
export { ExactCasperScheme } from "./exact/client";

// Exact scheme server
export { registerExactCasperScheme } from "./exact/server";
export type { CasperResourceServerConfig } from "./exact/server";

// Exact scheme facilitator
export { registerExactCasperScheme as registerExactCasperFacilitatorScheme } from "./exact/facilitator";
export type { CasperFacilitatorConfig } from "./exact/facilitator";

// Signers
export {
  createClientCasperSigner,
  toClientCasperSigner,
  createFacilitatorCasperSigner,
  toFacilitatorCasperSigner,
} from "./signer";
export type { ClientCasperSigner } from "./signer";
export type { FacilitatorCasperSigner } from "./signer";

// Types
export type { ExactCasperAuthorization, ExactCasperPayload } from "./types";

// Constants
export {
  NETWORK_CASPER_MAINNET,
  NETWORK_CASPER_TESTNET,
  NetworkConfigs,
  SCHEME_EXACT,
} from "./constants";
export type { NetworkConfig } from "./constants";

// Utils
export {
  chainNameFromNetwork,
  decodeContractPackageHash,
  formatAmount,
  getNetworkConfig,
  isValidAddress,
  isValidContractPackageHash,
  parseAmount,
} from "./utils";
