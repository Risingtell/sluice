/**
 * sluice-mcp - Model Context Protocol server for the Sluice streaming meter.
 *
 * Exposes Sluice to ANY MCP-capable AI agent (Claude, or anything speaking MCP): the agent can
 * discover metered streams, open a session, pay for it tick-by-tick with real Casper x402
 * settlements, watch its own spend, and close the gate. This is machine-to-machine commerce as
 * MCP tools: the LLM is the buyer.
 *
 * Run (stdio):
 *   npx tsx mcp/server.ts
 *
 * Env:
 *   SLUICE_SERVER_URL   target Sluice server (default http://localhost:4021)
 *   SLUICE_MODE         mock | live (default mock; live needs the key below)
 *   CLIENT_PRIVATE_KEY_PATH  PEM Casper key that signs live payments
 *   CLIENT_KEY_ALGO     ed25519 (default) | secp256k1
 *
 * Claude Code registration example:
 *   claude mcp add sluice -- npx tsx mcp/server.ts
 */
import { config as loadEnv } from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Sluice } from "../sdk/index.ts";

loadEnv();

const SERVER_URL = process.env.SLUICE_SERVER_URL || "http://localhost:4021";
const MODE = process.env.SLUICE_MODE === "live" ? "live" : "mock";

let sluicePromise: Promise<Sluice> | null = null;
function sluice(): Promise<Sluice> {
  sluicePromise ??= Sluice.connect({
    serverUrl: SERVER_URL,
    mode: MODE,
    keyPath: process.env.CLIENT_PRIVATE_KEY_PATH,
    keyAlgo: process.env.CLIENT_KEY_ALGO === "secp256k1" ? "secp256k1" : "ed25519",
  });
  return sluicePromise;
}

const TOOLS = [
  {
    name: "list_streams",
    description:
      "List the continuously-metered streams the Sluice server offers (id, title, provider, price per second in motes).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_session",
    description:
      "Open a metered streaming session. Opening is free; only paid ticks cost. Returns the session (keep its id).",
    inputSchema: {
      type: "object",
      properties: {
        streamId: { type: "string", description: "Stream id from list_streams, e.g. btc-usd" },
        objective: { type: "string", description: "Optional: why you are renting this stream (recorded)" },
      },
      required: ["streamId"],
      additionalProperties: false,
    },
  },
  {
    name: "pay_tick",
    description:
      "Pay for one tick of a session and receive the next data chunk. In live mode this signs a real Casper x402 " +
      "payment and returns the on-chain transaction hash. Each tick bills the elapsed seconds since the last paid tick.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "close_session",
    description:
      "Close the sluice gate on a session, ending payment. State the reason (e.g. objective met, not worth it, budget).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, reason: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_proof",
    description:
      "The public proof feed: cumulative settlement totals and recent settlements with explorer links.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

const server = new Server(
  { name: "sluice-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as any }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, string>;
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
  try {
    const s = await sluice();
    switch (req.params.name) {
      case "list_streams":
        return text(await s.listStreams());
      case "open_session":
        return text(await s.open(args.streamId, { policy: "mcp-agent", objective: args.objective }));
      case "pay_tick": {
        const t = await s.payTick(args.sessionId);
        return text({
          data: t.data,
          totalPaidMotes: t.session.totalPaid,
          ticks: t.session.ticks,
          txHash: t.txHash || null,
          explorerUrl: t.txHash ? `https://testnet.cspr.live/deploy/${t.txHash}` : null,
        });
      }
      case "close_session":
        return text(await s.close(args.sessionId, args.reason));
      case "get_proof": {
        const i = await s.impact();
        return text({ totals: i.totals, recent: i.recent.slice(0, 5) });
      }
      default:
        return { content: [{ type: "text" as const, text: `unknown tool: ${req.params.name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`sluice-mcp ready (stdio) -> ${SERVER_URL} [${MODE}]`);
