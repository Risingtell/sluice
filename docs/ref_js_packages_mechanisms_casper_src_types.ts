/**
 * Authorization fields for an Exact Casper payment.
 * Mirrors the Go ExactCasperAuthorization struct.
 */
export type ExactCasperAuthorization = {
  /** Payer account-hash address with "00" prefix. */
  from: string;
  /** Recipient account-hash address with "00" prefix. */
  to: string;
  /** Atomic token amount as a decimal string. */
  value: string;
  /** Unix timestamp after which the authorization is valid. */
  validAfter: string;
  /** Unix timestamp before which the authorization must be used. */
  validBefore: string;
  /** 32-byte nonce as a hex string. */
  nonce: string;
};

/**
 * Payload for an Exact Casper payment.
 * Mirrors the Go ExactCasperPayload struct.
 */
export type ExactCasperPayload = {
  /** 65-byte EIP-712 signature as a hex string. */
  signature: string;
  /** Full public key hex of the payer. */
  publicKey: string;
  /** Signed authorization fields. */
  authorization: ExactCasperAuthorization;
};
