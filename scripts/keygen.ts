/**
 * Generate a Casper ed25519 keypair for the agent (and optionally a payee/treasury).
 * Writes a PEM private key locally (gitignored) and prints the public key + account hash.
 *
 *   npx tsx scripts/keygen.ts agent
 *   npx tsx scripts/keygen.ts treasury
 */
import casperSdk from "casper-js-sdk";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const { KeyAlgorithm, PrivateKey } = casperSdk;

const name = process.argv[2] || "agent";
const dir = "keys";
const pemPath = `${dir}/${name}.pem`;

if (existsSync(pemPath)) {
  console.error(`✋ ${pemPath} already exists — refusing to overwrite. Delete it first if you really mean to.`);
  process.exit(1);
}

const pk = PrivateKey.generate(KeyAlgorithm.ED25519);
const pem = pk.toPem();
const publicKeyHex = pk.publicKey.toHex();
const accountHash = pk.publicKey.accountHash().toHex();

mkdirSync(dir, { recursive: true });
writeFileSync(pemPath, pem, { mode: 0o600 });

console.log(`\n🔑 Generated ed25519 key "${name}"`);
console.log(`   pem:          ${pemPath}  (gitignored — keep it secret)`);
console.log(`   publicKeyHex: ${publicKeyHex}`);
console.log(`   accountHash:  ${accountHash}`);
console.log(`\n   Fund this public key on Casper testnet:`);
console.log(`   https://testnet.cspr.live/tools/faucet`);
console.log(`   (the public key hex above is what the faucet + payee fields expect)\n`);
