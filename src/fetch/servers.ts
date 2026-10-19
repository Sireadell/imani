// The public servers Imani may ask for blocks and transactions. Kept apart from the fetch code
// so the page can show the same list without bundling any network code.

export type Network = "main" | "test";

/**
 * Default sources, each checked live on 2026-10-07 (see docs/fetch/DESIGN.md).
 * "https://host:port" is a light wallet server (lightwalletd or Zaino, gRPC).
 * "cipherscan:https://..." is the CipherScan explorer JSON API.
 * Order matters: the helper walks the list and stops as soon as it has enough copies,
 * so usually only the first two operators are contacted.
 */
export const DEFAULT_SERVERS: Record<Network, string[]> = {
  main: [
    "https://zec.rocks:443",
    "https://zec-node.cakewallet.com:443",
    "https://lwd.zcashexplorer.app:9067",
    "https://us.zec.stardust.rest:443",
    "https://zcash.mysideoftheweb.com:9067",
    "cipherscan:https://api.mainnet.cipherscan.app",
  ],
  test: ["https://testnet.zec.rocks:443", "cipherscan:https://api.testnet.cipherscan.app"],
};

/** A server's host name alone, as a reader would recognise it: "testnet.zec.rocks". */
export function hostOf(server: string): string {
  return server.replace(/^cipherscan:/, "").replace(/^[a-z]+:\/\//, "").replace(/:\d+$/, "").replace(/\/.*$/, "");
}
