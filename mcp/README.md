# sluice-mcp

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

## Register with Claude Code

With a local Sluice server in mock mode (no keys, nothing is paid): run `npm run server` in a clone
of [the repo](https://github.com/Risingtell/sluice), then

```bash
claude mcp add sluice -- npx -y sluice-mcp
```

With the hosted server, paying real ticks on Casper testnet from your own account:

```bash
claude mcp add sluice \
  -e SLUICE_SERVER_URL=https://sluice-kff3.onrender.com \
  -e SLUICE_MODE=live \
  -e CLIENT_PRIVATE_KEY_PATH=/path/to/your-casper-key.pem \
  -- npx -y sluice-mcp
```

Then ask the agent to "rent the btc-usd stream with a 0.05 X402 budget and stop when you have
three quotes" and watch it drive the meter itself. Any other MCP client runs the same command
(`npx -y sluice-mcp`, stdio). Node 20 or newer.

The first `npx -y sluice-mcp` downloads the package, which can take longer than a client's startup
limit (30 seconds in Claude Code). Run it once in a terminal first and stop it when it prints
`sluice-mcp ready`, or start Claude Code with `MCP_TIMEOUT=90000`.

## Environment

```
SLUICE_SERVER_URL=http://localhost:4021   # default; the hosted server is https://sluice-kff3.onrender.com
SLUICE_MODE=mock                          # or live
SLUICE_NETWORK=casper:casper-test         # live only, optional: the network to pay on
CLIENT_PRIVATE_KEY_PATH=keys/agent.pem    # live only: the paying Casper account
CLIENT_KEY_ALGO=ed25519
```

Mock mode needs a server in mock mode; nothing is signed or paid. In live mode the agent pays from
your own Casper account: on the hosted server that is Casper testnet, and its faucet sends X402 test
tokens to your account (see the
[main README](https://github.com/Risingtell/sluice#onboard-your-own-agent-no-need-to-ask-us)).

Built on the [`sluice-x402`](https://www.npmjs.com/package/sluice-x402) SDK. Source:
[github.com/Risingtell/sluice](https://github.com/Risingtell/sluice). MIT.
