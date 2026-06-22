import casperSdk from "casper-js-sdk";
import type {
  KeyAlgorithm as KeyAlgorithmType,
  PrivateKey as PrivateKeyType,
  Transaction,
} from "casper-js-sdk";
import { Network } from "@x402/core/types";
import { NetworkConfig } from "./constants";

/**
 * Pause execution for the given number of milliseconds.
 *
 * @param ms - Milliseconds to sleep.
 * @returns A promise that resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const { KeyAlgorithm, PrivateKey, RpcClient, HttpHandler } = casperSdk;

/**
 * Client-side signer for Casper x402 payments.
 */
export interface ClientCasperSigner {
  /**
   * Get the payer account-hash address as a 66-character hex string
   * prefixed with "00".
   *
   * @returns Account-hash address.
   */
  accountAddress(): string;

  /**
   * Get the payer's full public key hex, including the algorithm prefix byte.
   *
   * @returns Public key hex.
   */
  publicKey(): string;

  /**
   * Sign a 32-byte EIP-712 digest.
   *
   * @param digest - 32-byte digest to sign.
   * @returns 65-byte signature: [1 algorithm byte | 64 raw signature bytes].
   */
  signEIP712(digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * Wrap an existing casper-js-sdk PrivateKey into a ClientCasperSigner.
 *
 * @param privateKey - The Casper private key.
 * @returns A ClientCasperSigner instance.
 */
export function toClientCasperSigner(privateKey: PrivateKeyType): ClientCasperSigner {
  const accountAddress = "00" + privateKey.publicKey.accountHash().toHex();
  const publicKey = privateKey.publicKey.toHex();

  return {
    accountAddress: () => accountAddress,
    publicKey: () => publicKey,
    signEIP712: async digest => privateKey.signAndAddAlgorithmBytes(digest),
  };
}

/**
 * Create a ClientCasperSigner from a PEM private-key file.
 *
 * @param pemPath - Path to the PEM-encoded private key file.
 * @param algorithm - Key algorithm, defaults to ed25519.
 * @returns A ClientCasperSigner instance.
 */
export async function createClientCasperSigner(
  pemPath: string,
  algorithm: KeyAlgorithmType = KeyAlgorithm.ED25519,
): Promise<ClientCasperSigner> {
  const { readFile } = await import("fs/promises");
  const pemContent = await readFile(pemPath, "utf-8");
  const privateKey = PrivateKey.fromPem(pemContent, algorithm);
  return toClientCasperSigner(privateKey);
}

/**
 * Facilitator-side signer for Casper x402 settlements.
 *
 * Wraps a Casper private key and an RPC client so the exact facilitator can
 * build, sign, submit, and monitor transactions on a Casper network.
 */
export interface FacilitatorCasperSigner {
  getNetworkConfig(network: Network): Promise<NetworkConfig>;
  getAddresses(network: Network): string[];
  getPublicKeyHex(network: Network): string;
  signTransaction(transaction: Transaction, network: Network): Promise<void>;
  putTransaction(network: Network, transaction: Transaction): Promise<string>;
  waitForTransaction(network: Network, transactionHash: string): Promise<void>;
}

/**
 * Create a FacilitatorCasperSigner from a casper-js-sdk PrivateKey and RPC URL.
 *
 * @param privateKey - The Casper private key used to sign transactions.
 * @param rpcUrl - JSON-RPC endpoint for the Casper network.
 * @returns A FacilitatorCasperSigner instance.
 */
export async function toFacilitatorCasperSigner(
  privateKey: PrivateKeyType,
  rpcUrl: string,
): Promise<FacilitatorCasperSigner> {
  const rpcClient = new RpcClient(new HttpHandler(rpcUrl));

  return {
    getNetworkConfig: async network => ({
      chainName: network.split(":").slice(1).join(":"),
      rpcUrl,
    }),

    getAddresses: () => [privateKey.publicKey.accountHash().toHex()],

    getPublicKeyHex: () => privateKey.publicKey.toHex(),

    signTransaction: async transaction => {
      transaction.sign(privateKey);
    },

    putTransaction: async (_network, transaction) => {
      const result = await rpcClient.putTransaction(transaction);
      return result.transactionHash.toHex();
    },

    waitForTransaction: async (_network, transactionHash) => {
      const start = Date.now();
      const timeoutMs = 60_000;
      const pollIntervalMs = 3_000;

      while (Date.now() - start < timeoutMs) {
        const info = await rpcClient.getTransactionByTransactionHash(transactionHash);

        // Wait until the transaction has been included in a finalized block
        // and an execution result has been attached.
        const execInfo = info.executionInfo;
        if (execInfo && execInfo.blockHeight !== 0 && execInfo.executionResult) {
          // Surface on-chain execution failures so the caller can propagate them
          const errorMessage = execInfo.executionResult.errorMessage;
          if (errorMessage) {
            throw new Error(`transaction execution failed: ${errorMessage}`);
          }
          return;
        }

        await sleep(pollIntervalMs);
      }

      throw new Error(`Timed out waiting for transaction ${transactionHash}`);
    },
  };
}

/**
 * Create a FacilitatorCasperSigner from a PEM private-key file.
 *
 * @param pemPath - Path to the PEM-encoded private key file.
 * @param algorithm - Key algorithm, defaults to ed25519.
 * @param rpcUrl - JSON-RPC endpoint for the Casper network.
 * @returns A FacilitatorCasperSigner instance.
 */
export async function createFacilitatorCasperSigner(
  pemPath: string,
  algorithm: KeyAlgorithmType = KeyAlgorithm.ED25519,
  rpcUrl: string,
): Promise<FacilitatorCasperSigner> {
  const { readFile } = await import("fs/promises");
  const pemContent = await readFile(pemPath, "utf-8");
  const privateKey = PrivateKey.fromPem(pemContent, algorithm);
  return toFacilitatorCasperSigner(privateKey, rpcUrl);
}
