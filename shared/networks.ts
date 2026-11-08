/**
 * The Casper networks Sluice settles on, in one place: CAIP-2 ids, explorers, public RPC nodes and
 * chain names. Mainnet is the default path; testnet stays available for free test runs.
 */

export const MAINNET = "casper:casper";
export const TESTNET = "casper:casper-test";

export const isMainnet = (network: string | undefined): boolean => network === MAINNET;

/** cspr.live hosts mainnet; testnet lives on its own subdomain. */
export const explorerFor = (network: string | undefined): string => (isMainnet(network) ? "https://cspr.live" : "https://testnet.cspr.live");

export const rpcFor = (network: string | undefined): string =>
  isMainnet(network) ? "https://node.mainnet.casper.network/rpc" : "https://node.testnet.casper.network/rpc";

export const chainNameFor = (network: string | undefined): string => (isMainnet(network) ? "casper" : "casper-test");

export const labelFor = (network: string | undefined): string => (isMainnet(network) ? "Casper mainnet" : "Casper testnet");

/**
 * A private RPC node for a network, if one is configured: FACILITATOR_RPC_URL_MAINNET or
 * FACILITATOR_RPC_URL_TESTNET, or FACILITATOR_RPC_URL when only one network is served (one URL
 * cannot name a node on two networks). Undefined means the public node.
 */
export function rpcOverride(network: string, env: Record<string, string | undefined>, networkCount: number): string | undefined {
  const own = network === MAINNET ? env.FACILITATOR_RPC_URL_MAINNET : network === TESTNET ? env.FACILITATOR_RPC_URL_TESTNET : undefined;
  return own || (networkCount === 1 ? env.FACILITATOR_RPC_URL : undefined);
}

/** Parses "casper:casper,casper:casper-test" into a de-duplicated list, keeping the order (first = default). */
export function parseNetworks(list: string | undefined): string[] {
  const out: string[] = [];
  for (const n of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) if (!out.includes(n)) out.push(n);
  return out;
}

/**
 * Picks the payment option an x402 client pays with. With `preferred` set, only that network is
 * accepted: a buyer who asked for testnet must never end up paying on mainnet because a server
 * listed it first. Without it, the first Casper option wins, which is mainnet on a Sluice server.
 */
export function networkSelector(preferred?: string) {
  return (_version: number, options: { network: string }[]) => {
    if (preferred) {
      const match = options.find((o) => o.network === preferred);
      if (!match) throw new Error(`this server does not accept payment on ${preferred}; it offers ${options.map((o) => o.network).join(", ")}`);
      return match;
    }
    return options.find((o) => o.network.startsWith("casper:")) ?? options[0];
  };
}
