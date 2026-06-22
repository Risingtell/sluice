import cors from "cors";
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/server";
import { FacilitatorConfig, HTTPFacilitatorClient } from "@x402/core/server";
import { AssetAmount, Network } from "@x402/core/types";

config();

// ---- Configuration (mirrors go/examples/server/config.go) ---------------------
interface Env {
  logLevel: string;
  port: number;
  payeeAddress: string;
  facilitatorURL: string;
  facilitatorAPIKey: string;
  chainID: string;
  assetPackage: string;
  assetName: string;
}

function parseEnv(): Env {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) {
      console.error(`❌ ${key} environment variable is required`);
      process.exit(1);
    }
    return v;
  };

  return {
    logLevel: process.env.LOG_LEVEL || "info",
    port: parseInt(process.env.PORT || "4021", 10),
    payeeAddress: required("PAYEE_ADDRESS"),
    facilitatorURL: required("FACILITATOR_URL"),
    facilitatorAPIKey: process.env.FACILITATOR_API_KEY || "",
    chainID: required("CAIP2_CHAIN_ID"),
    assetPackage: required("ASSET_PACKAGE"),
    assetName: required("ASSET_NAME"),
  };
}

const cfg = parseEnv();

// ASSET_PACKAGE may include the "hash-" prefix; strip it to match the Go server.
const assetPackage = cfg.assetPackage.replace(/^hash-/, "");
const chainID = cfg.chainID as Network;

// ---- Facilitator client (with optional API key auth) -------------------------
const facilitatorConfig: FacilitatorConfig = { url: cfg.facilitatorURL };
if (cfg.facilitatorAPIKey) {
  const auth = { Authorization: cfg.facilitatorAPIKey };
  facilitatorConfig.createAuthHeaders = async () => ({
    verify: auth,
    settle: auth,
    supported: auth,
    bazaar: auth,
  });
}
const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

// ---- Casper scheme (mirrors the Go MoneyParser + RegisterAsset) --------------
const assetAmount: AssetAmount = {
  asset: assetPackage,
  amount: "7500000000",
  extra: { name: cfg.assetName, symbol: "WCSPR", version: "1", decimals: "9" },
};

const casperScheme = new ExactCasperScheme()
  .registerAsset(chainID, assetPackage, 9)
  .registerMoneyParser(() => Promise.resolve(assetAmount));

// ---- App --------------------------------------------------------------------
const app = express();

// CORS — mirrors go/examples/server/main.go: AllowAllOrigins + the same method,
// header, expose-header, and max-age settings so the JS example accepts
// browser preflight from any origin (including the CSPR.click React demo at
// http://localhost:4020).
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Accept", "Authorization", "Content-Type", "Origin", "Payment-Signature"],
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
    maxAge: 24 * 60 * 60, // 24h, matching MaxAge: 24 * time.Hour
  }),
);

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: chainID,
            payTo: cfg.payeeAddress,
          },
        ],
        description: "Get weather data for a city",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(chainID, casperScheme),
  ),
);

app.get("/weather", (req, res) => {
  const city = (req.query.city as string) || "Barcelona";
  const weatherData: Record<string, { weather: string; temperature: number }> = {
    Barcelona: { weather: "sunny", temperature: 45 },
    "San Francisco": { weather: "foggy", temperature: 60 },
    "New York": { weather: "cloudy", temperature: 55 },
    London: { weather: "rainy", temperature: 50 },
    Tokyo: { weather: "clear", temperature: 65 },
  };
  const data = weatherData[city] || { weather: "sunny", temperature: 70 };
  res.json({
    city,
    weather: data.weather,
    temperature: data.temperature,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.0.0" });
});

app.listen(cfg.port, () => {
  console.log(`Server listening at http://localhost:${cfg.port}`);
});
