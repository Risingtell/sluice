// Behind Cloudflare and Render every visitor reaches Sluice from the proxy's address, so the
// per-visitor limits must read the visitor's own address from Cloudflare's header, and only where
// Cloudflare sets that header.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { clientIp, clientIpHeader, clientIpInfo } from "../shared/client-ip.ts";
import { TESTNET } from "../shared/networks.ts";
import type { ServerConfig } from "../server/src/config.ts";

// req.ip may come from X-Forwarded-For (live mode trusts one proxy hop); the socket is the real peer.
const req = (headers: Record<string, string | string[]>, socket = "10.0.0.7", ip = socket) => ({ headers, ip, socket: { remoteAddress: socket } }) as never;
const CF = "cf-connecting-ip";

/** Runs fn with these environment variables set (undefined removes one), then restores them. */
const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};

describe("the visitor's address behind Cloudflare and Render", () => {
  test("is Cloudflare's CF-Connecting-IP when it is trusted and there", () => {
    assert.equal(clientIp(req({ [CF]: "203.0.113.9" }), CF), "203.0.113.9");
    assert.equal(clientIp(req({ [CF]: " 2001:db8::7 " }), CF), "2001:db8::7");
    assert.deepEqual(clientIpInfo(req({ [CF]: "203.0.113.9" }), CF), { ip: "203.0.113.9", from: CF });
  });

  test("is the socket address without that header, or when it holds anything but one outside address", () => {
    assert.equal(clientIp(req({}), CF), "10.0.0.7");
    assert.deepEqual(clientIpInfo(req({ [CF]: "203.0.113.9, 198.51.100.2" }), CF), { ip: "10.0.0.7", from: "socket" });
    assert.equal(clientIp(req({ [CF]: "not-an-address" }), CF), "10.0.0.7");
    // A loopback value would share the bucket of this server's own calls to its facilitator.
    for (const loop of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "0:0:0:0:0:ffff:127.0.0.1"]) {
      assert.equal(clientIp(req({ [CF]: loop }), CF), "10.0.0.7", loop);
    }
  });

  test("is never an address a client wrote in X-Forwarded-For", () => {
    // Off Render with trust proxy on, req.ip is the last X-Forwarded-For entry, which a client controls.
    assert.equal(clientIp(req({ "x-forwarded-for": "127.0.0.1" }, "10.0.0.7", "127.0.0.1"), ""), "10.0.0.7");
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.50" }, "10.0.0.7", "203.0.113.50"), ""), "10.0.0.7");
  });

  test("trusts the header on Render only, unless the deployment names one or turns it off", () => {
    assert.equal(withEnv({ RENDER: undefined, CLIENT_IP_HEADER: undefined }, clientIpHeader), "");
    assert.equal(withEnv({ RENDER: "true", CLIENT_IP_HEADER: undefined }, clientIpHeader), CF);
    assert.equal(withEnv({ RENDER: "true", CLIENT_IP_HEADER: "" }, clientIpHeader), "");
    assert.equal(withEnv({ RENDER: undefined, CLIENT_IP_HEADER: "X-Real-IP" }, clientIpHeader), "x-real-ip");
    // Off the header is ignored: a client cannot choose its own bucket on a host without Cloudflare.
    assert.equal(withEnv({ RENDER: undefined, CLIENT_IP_HEADER: undefined }, () => clientIp(req({ [CF]: "203.0.113.9" }))), "10.0.0.7");
  });
});

describe("the faucet's per-visitor cap", () => {
  test("counts two visitors behind the same proxy separately", async () => {
    // A visitor who already had today's 3 grants, recorded under their own address. The faucet reads
    // its state path and limits when it loads, so set them before importing it.
    const dir = mkdtempSync(join(tmpdir(), "sluice-faucet-"));
    const state = join(dir, "faucet.json");
    writeFileSync(state, JSON.stringify({ day: new Date().toISOString().slice(0, 10), globalToday: 3, perIpToday: { "203.0.113.1": 3 }, served: {} }));
    Object.assign(process.env, {
      FAUCET_STATE_PATH: state,
      FAUCET_PER_IP_PER_DAY: "3",
      FAUCET_GLOBAL_PER_DAY: "40",
      CLIENT_IP_HEADER: CF, // as on Render
      CLIENT_PRIVATE_KEY_PATH: join(dir, "no-key.pem"), // a grant stops before any network call
    });
    const { mountFaucet } = await import("../server/src/faucet.ts");

    const cfg = {
      mode: "live",
      assetName: "Casper X402 Token",
      networks: [{ id: TESTNET, assetPackage: "658bb84ba4aa82ffc98a55e0f8c447103dd9d4a28fb32fca3363aa0e1300017e", explorer: "https://testnet.cspr.live" }],
    } as unknown as ServerConfig;
    const app = express();
    app.use(express.json());
    mountFaucet(app, cfg);
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/faucet`;
      const ask = (visitor: string, address: string) =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", [CF]: visitor }, body: JSON.stringify({ address, network: TESTNET }) });

      const capped = await ask("203.0.113.1", "00" + "a".repeat(64));
      assert.equal(capped.status, 429);
      assert.match(String(((await capped.json()) as { error?: string }).error), /daily limit reached for this client/);

      // Another visitor through the same proxy is not refused by the first one's cap: the request goes
      // on to the grant, which this test deployment cannot make (no key), so it fails there instead.
      const other = await ask("203.0.113.2", "00" + "b".repeat(64));
      assert.equal(other.status, 503);
      assert.match(String(((await other.json()) as { error?: string }).error), /not configured/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
