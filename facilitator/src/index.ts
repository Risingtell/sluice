/**
 * Sluice x402 facilitator, standalone.
 *
 * Runs the facilitator router (see router.ts) as its own process. The deployed Sluice service
 * mounts the same router in-process at /facilitator, so this entry point exists for local work and
 * for anyone who wants to run the facilitator separately.
 *
 *   npm run facilitator
 */
import express from "express";
import { config as loadEnv } from "dotenv";
import { createFacilitatorRouter, facilitatorOptionsFromEnv } from "./router.ts";

loadEnv();

const PORT = parseInt(process.env.FACILITATOR_PORT || "4022", 10);

async function main(): Promise<void> {
  const opts = facilitatorOptionsFromEnv();
  const { router, feePayer } = await createFacilitatorRouter(opts);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/", router);

  app.listen(PORT, () => {
    console.log(`\nSluice x402 facilitator`);
    console.log(`   networks: ${opts.networks.join(", ")}`);
    console.log(`   feePayer: ${feePayer.join(", ")}`);
    console.log(`   gas cap:  ${(opts.paymentMotes / 1e9).toFixed(2)} CSPR per settlement`);
    console.log(`   allowlist: ${opts.allowedAssets.size || "any"} asset(s), ${opts.allowedPayees.size || "any"} payee(s)`);
    console.log(`   auth:     ${opts.secret ? "shared secret required" : "OPEN (set FACILITATOR_SHARED_SECRET)"}`);
    console.log(`   listen:   http://localhost:${PORT}\n`);
  });
}

main().catch((err) => {
  console.error("facilitator failed to start:", (err as Error).message);
  process.exit(1);
});
