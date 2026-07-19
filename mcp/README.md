# sluice-mcp - MCP server

Exposes the Sluice streaming meter to **any MCP-capable AI agent** (Claude, or anything speaking
the Model Context Protocol). The LLM becomes the buyer: it can discover metered streams, open a
session, pay tick-by-tick with real Casper x402 settlements, watch its own spend, and close the
gate with a stated reason. Machine-to-machine commerce as MCP tools.

## Tools

| Tool | What the agent can do |
|---|---|
| `list_streams` | discover the metered catalogue and per-second prices |
| `open_session` | open a session (free) with an optional stated objective |
| `pay_tick` | pay one tick, receive the next chunk; live mode returns the on-chain tx hash + explorer link |
| `close_session` | close the sluice gate, stating why |
| `get_proof` | read the public settlement proof feed |

## Run

```bash
npx tsx mcp/server.ts                    # stdio, mock mode against http://localhost:4021
```

Environment:

```
SLUICE_SERVER_URL=http://localhost:4021   # or the deployed server
SLUICE_MODE=mock                          # or live
CLIENT_PRIVATE_KEY_PATH=keys/agent.pem    # live only: the paying Casper account
CLIENT_KEY_ALGO=ed25519
```

## Register with Claude Code

```bash
claude mcp add sluice -- npx tsx mcp/server.ts
```

Then ask the agent to "rent the btc-usd stream with a 0.05 X402 budget and stop when you have
three quotes" and watch it drive the meter itself.
