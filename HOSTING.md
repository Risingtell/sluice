# Hosting the Sluice proof feed on a stable public URL

Judges need one URL that stays up. Sluice's cumulative proof feed (138+ real settlements) already
lives on this machine in `server/.data/impact.json`, so the **recommended** path keeps that state and
just gives it a permanent address.

---

## Recommended: Cloudflare **named** tunnel (free, stable hostname, keeps existing proof data)

Unlike the quick tunnel (`--url`, which mints a throwaway hostname on every restart), a *named* tunnel
binds to a fixed hostname you control. Free, no server move, the 138 existing settlements stay.

**One-time setup (needs you to log in once to your Cloudflare account):**

```bash
# 1. Authenticate cloudflared with your Cloudflare account (opens a browser)
./cloudflared.exe tunnel login

# 2. Create the named tunnel (writes a credentials file under ~/.cloudflared)
./cloudflared.exe tunnel create sluice

# 3. Route a hostname to it (uses a domain on your Cloudflare account)
./cloudflared.exe tunnel route dns sluice sluice.<your-domain>
```

**Run it (alongside the live server):**

```bash
# terminal 1 — the always-on LIVE server
MODE=live npm run server

# terminal 2 — the stable tunnel
./cloudflared.exe tunnel run --url http://localhost:4021 sluice
```

Your stable feed is then `https://sluice.<your-domain>/impact.html`. Put that URL in
[`SUBMISSION.md`](SUBMISSION.md).

> No domain on Cloudflare? Either add one (free zone) or fall back to the cloud option below.

---

## Alternative: deploy the server to the cloud (Fly.io — persistent volume)

Use this if you'd rather not keep this machine running. It needs a **persistent volume** so the
proof feed survives restarts (a free Render web service has ephemeral disk and would reset it).

A `Dockerfile` is included. With Fly:

```bash
fly launch --no-deploy                       # generates fly.toml
fly volumes create sluice_data --size 1       # persistent disk for impact.json
# mount it at /data and point SNAPSHOT_PATH=/data/impact.json (set in fly.toml [env] + [mounts])
fly secrets set MODE=live \
  FACILITATOR_API_KEY=... PAYEE_ADDRESS=... ASSET_PACKAGE=... ASSET_NAME="Casper X402 Token" \
  CAIP2_CHAIN_ID=casper:casper-test
fly deploy
```

The agent / `scripts/volume.sh` can keep running locally against the public server URL to generate
volume — only the **server** needs to be always-on for judging.

> **Migrating existing proof data:** copy your local `server/.data/impact.json` onto the volume once
> (`fly ssh console` → write to `/data/impact.json`) so the 138 settlements carry over.

---

## Security reminder

The cspr.cloud facilitator key and the agent PEM are gitignored — never commit them. The facilitator
key was exposed in chat during development; **regenerate it after the event.**
