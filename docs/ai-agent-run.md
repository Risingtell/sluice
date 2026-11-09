# Claude as a Sluice buyer

On 2026-11-09, Claude ran as an autonomous buyer of a Sluice stream. It reached Sluice only through the
published MCP server (`npx -y sluice-mcp`, [npm](https://www.npmjs.com/package/sluice-mcp)) and paid
every tick with a real x402 settlement on **Casper testnet** from its own wallet. The data it paid for
is live **Casper mainnet** block production, read from a public Casper node. It was given a goal and
a tick limit, and decided from each response when to stop paying.

- Model: `claude-opus-5-5` in Claude Code, headless (`claude -p`), allowed to use only the five Sluice tools
- Server: a Sluice server running this repo's code, live on `casper:casper-test` only
- Result: **2 paid ticks**, 0.006327 X402 in total, then Claude closed the gate itself

## The task Claude was given

```
You are an autonomous AI agent that buys live data by the second. The `sluice` MCP tools connect you to a Sluice streaming server; every tick you pay is a real x402 settlement on Casper testnet, paid from your own wallet.

Task: rent the `casper-blocks` stream (live Casper mainnet blocks) and decide for yourself how long it is worth paying for.
1. Call list_streams, then open one session on casper-blocks with a one-line objective.
2. Pay one tick at a time with pay_tick, and read the block height in each response before deciding whether to continue.
3. Your goal: see two new blocks after the first height you receive. Stop paying as soon as you have them, or if a response says live is false, or after 8 ticks at most.
4. Close the session with a one-sentence reason.

Then reply with a short table (tick, block height, seconds since block, transaction link) and your closing reason. Do not open a second session.
```

## What Claude did

- **Tool call:** `list_streams`
- **Result:** 3 streams: `btc-usd`, `eth-usd`, `casper-blocks`
- **Tool call:** `open_session` `{"streamId":"casper-blocks","objective":"Watch Casper mainnet until two new blocks appear after the first observed height, then stop paying."}`
- **Result:** session `a623f394…` opened on `casper-blocks`
- **Tool call:** `pay_tick` `{"sessionId":"a623f394-dd44-4c9f-9d7d-dc715f3d5f96"}`
- **Result:** paid, block **9530195** (3s old, live true), [tx 54022666…](https://testnet.cspr.live/deploy/5402266664430811990ba0f08525478734525eb3592727ecd17c4c89bc03f7fc)
- > First height is 9,530,195, so I need to reach 9,530,197. Paying the next tick.
- **Tool call:** `pay_tick` `{"sessionId":"a623f394-dd44-4c9f-9d7d-dc715f3d5f96"}`
- **Result:** paid, block **9530197** (4s old, live true), [tx 2d456a9c…](https://testnet.cspr.live/deploy/2d456a9c6d646ce47f0b5d43cd39441283adfe61655b3723dfb6caf48b8ef41c)
- > Height jumped from 9,530,195 to 9,530,197, so the chain has produced two new blocks. That meets the goal, so I'm closing the session.
- **Tool call:** `close_session` `{"sessionId":"a623f394-dd44-4c9f-9d7d-dc715f3d5f96","reason":"Objective met: the chain went from height 9530195 to 9530197 (two new blocks) in 2 ticks, so further ticks would cost more without adding anything."}`
- **Result:** session closed, 2 ticks
- > I got the two new blocks in 2 ticks and closed the session. I paid 6,327,000 motes in total, which is about 12.7 seconds at 500,000 motes per second. Both payments settled on Casper testnet.
  > 
  > | Tick | Block height | Seconds since block | Transaction |
  > |---|---|---|---|
  > | 1 | 9,530,195 | 3 | [540226…bc03f7fc](https://testnet.cspr.live/deploy/5402266664430811990ba0f08525478734525eb3592727ecd17c4c89bc03f7fc) |
  > | 2 | 9,530,197 | 4 | [2d456a…b8ef41c](https://testnet.cspr.live/deploy/2d456a9c6d646ce47f0b5d43cd39441283adfe61655b3723dfb6caf48b8ef41c) |
  > 
  > The second tick came about 17 seconds after the first, and in that time the height went up by two. I never received block 9,530,196 itself, only the height jump that shows it was produced. Both ticks reported `live: true`.
  > 
  > **Closing reason:** Objective met: the chain went from height 9530195 to 9530197 (two new blocks) in 2 ticks, so further ticks would cost more without adding anything.

## The settlements

| Tick | Mainnet block | Seconds since block | Settlement on Casper testnet |
|---|---|---|---|
| 1 | 9530195 | 3 | [54022666…](https://testnet.cspr.live/deploy/5402266664430811990ba0f08525478734525eb3592727ecd17c4c89bc03f7fc) |
| 2 | 9530197 | 4 | [2d456a9c…](https://testnet.cspr.live/deploy/2d456a9c6d646ce47f0b5d43cd39441283adfe61655b3723dfb6caf48b8ef41c) |

**Closing reason, in Claude's words:** Objective met: the chain went from height 9530195 to 9530197 (two new blocks) in 2 ticks, so further ticks would cost more without adding anything.

Every link opens the real transfer on testnet.cspr.live: a CEP-18 `transfer_with_authorization` from
the agent's account to the Helios Feeds treasury.

## Run it yourself

Point any MCP-capable agent at the hosted server (Casper testnet; the faucet sends your account X402
test tokens, see the [README](../README.md#onboard-your-own-agent-no-need-to-ask-us)):

```bash
claude mcp add sluice \
  -e SLUICE_SERVER_URL=https://sluice-kff3.onrender.com \
  -e SLUICE_MODE=live \
  -e CLIENT_PRIVATE_KEY_PATH=/path/to/your-casper-key.pem \
  -- npx -y sluice-mcp
```
