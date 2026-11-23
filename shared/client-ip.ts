import { isIP } from "node:net";
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

/**
 * The visitor's own address, for the per-visitor limits (the faucet's daily cap and the
 * facilitator's rate limit), and where it came from. Hosted Sluice sits behind Cloudflare and then
 * Render's proxy, so the socket address and the nearest X-Forwarded-For entry belong to the proxies
 * and every visitor looks like the same one. Cloudflare puts the visitor's address in a header
 * (CF-Connecting-IP) and replaces any value a client sends, so where that header is trusted (see
 * clientIpHeader) it is read first. It must hold exactly one address and never a loopback one, which
 * belongs to this server's own calls to its facilitator. Otherwise this is the socket address, never
 * req.ip: live mode trusts one proxy hop (for the 402's https URL), so off Render req.ip is whatever
 * a client writes last in X-Forwarded-For.
 */
export function clientIpInfo(req: Request, header = clientIpHeader()): { ip: string; from: string } {
  if (header) {
    const raw = req.headers[header];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value && isIP(value) && !isLoopback(value)) return { ip: value, from: header };
  }
  return { ip: String(req.socket?.remoteAddress || "unknown"), from: "socket" };
}

export const clientIp = (req: Request, header = clientIpHeader()): string => clientIpInfo(req, header).ip;

/**
 * The request header that carries the visitor's address, lowercase, or "" for none. On Render
 * (which sets RENDER in every service's environment) it defaults to Cloudflare's CF-Connecting-IP,
 * because requests reach Render through Cloudflare, which overwrites that header. Anywhere else a
 * client could send it itself and pick its own limits, so it is off unless CLIENT_IP_HEADER names
 * a header that a proxy you control sets.
 */
export const clientIpHeader = (): string =>
  (process.env.CLIENT_IP_HEADER ?? (process.env.RENDER ? "cf-connecting-ip" : "")).trim().toLowerCase();

// Normalised first, so every spelling of a loopback address (::ffff:7f00:1, ::127.0.0.1) is caught.
const isLoopback = (ip: string): boolean => {
  const n = ipKeyGenerator(ip, false);
  return /^127\./.test(n) || n === "::1" || /^::ffff:127\./i.test(n);
};
