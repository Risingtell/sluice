import { config } from "dotenv";
import { x402Client, x402HTTPClient, wrapFetchWithPayment, type PaymentRequirements } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";

const { KeyAlgorithm } = casperSdk;

config();

const casperPrivateKeyPath = process.env.CLIENT_PRIVATE_KEY_PATH as string | undefined;
const casperKeyAlgorithm = process.env.CLIENT_KEY_ALGO as string | undefined;
const baseURL = process.env.SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Main example runner for advanced x402 client patterns.
 *
 * This package demonstrates advanced patterns for production-ready x402 clients:
 *
 * - all-networks: All supported networks with optional chain configuration
 * - builder-pattern: Fine-grained control over network registration
 * - hooks: Payment lifecycle hooks for custom logic at different stages
 * - preferred-network: Client-side payment network preferences
 *
 * To run this example, you need to set the following environment variables:
 * - CLIENT_PRIVATE_KEY_PATH: Path to a PEM-encoded Casper private key (required)
 * - CLIENT_KEY_ALGO: "ed25519" or "secp256k1" (optional, defaults to ed25519)
 * - SERVER_URL: Base URL of the resource server (optional, defaults to http://localhost:4021)
 *
 */
async function main(): Promise<void> {

  console.log(`\n🚀 Running advanced example\n`);

  if (!casperPrivateKeyPath) {
    console.error("❌ CLIENT_PRIVATE_KEY_PATH environment variable is required");
    process.exit(1);
  }

  // Define network preference order (most preferred first)
  const networkPreferences = ["casper:"];

  /**
   * Custom selector that picks payment options based on preference order.
   *
   * NOTE: By the time this selector is called, `options` has already been
   * filtered to only include options that BOTH the server offers AND the
   * client has registered support for. So fallback to options[0] means
   * "first mutually-supported option" (which preserves server's preference order).
   *
   * @param _x402Version - The x402 protocol version
   * @param options - Array of mutually supported payment options
   * @returns The selected payment requirement based on network preference
   */
  const preferredNetworkSelector = (
    _x402Version: number,
    options: PaymentRequirements[],
  ): PaymentRequirements => {
    console.log("📋 Mutually supported payment options (server offers + client supports):");
    options.forEach((opt, i) => {
      console.log(`   ${i + 1}. ${opt.network} (${opt.scheme})`);
    });
    console.log();

    // Try each preference in order
    for (const preference of networkPreferences) {
      const match = options.find(opt => opt.network.startsWith(preference));
      if (match) {
        console.log(`✨ Selected preferred network: ${match.network}`);
        return match;
      }
    }

    // Fallback to first mutually-supported option (server's top preference among what we support)
    console.log(`⚠️  No preferred network available, falling back to: ${options[0].network}`);
    return options[0];
  };

  const algorithm =
    casperKeyAlgorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const casperSigner = await createClientCasperSigner(casperPrivateKeyPath, algorithm);

  const client = new x402Client(preferredNetworkSelector)
    .register("casper:*", new ExactCasperScheme(casperSigner));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`🌐 Making request to: ${url}\n`);
  const response = await fetchWithPayment(url, { method: "GET" });
  const body = await response.json();

  console.log("✅ Request completed successfully\n");
  console.log("Response body:", body);

  // Extract payment response from headers
  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response.headers.get(name),
  );
  if (paymentResponse) {
    console.log("\n💰 Payment Details:", paymentResponse);
  }
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
