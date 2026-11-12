/** Public QoreChain endpoints. The fest runs on Diana (testnet); the KEM key registry is live there. */
export interface Network {
  name: "testnet" | "mainnet";
  chainId: string;
  evmChainId: number;
  rest: string;
  rpc: string;
  evmRpc: string;
  /** SealedInbox (contracts/SealedInbox.sol) on this network, once deployed. */
  inbox?: `0x${string}`;
  /** The EVM transaction that deployed it, and its block (log reads start there). */
  inboxDeployTx?: string;
  inboxFromBlock?: bigint;
  /** The public explorer keeps its network in a cookie: tell the reader which one to pick. */
  explorer: string;
  explorerNote?: string;
  /** Raw tx JSON from the chain's own REST API: always opens on the right network. */
  restTx: (hash: string) => string;
}

export const NETWORKS: Record<Network["name"], Network> = {
  testnet: {
    name: "testnet",
    chainId: "qorechain-diana",
    evmChainId: 9800,
    rest: "https://api-testnet.qore.host",
    rpc: "https://rpc-testnet.qore.host",
    evmRpc: "https://evm-testnet.qore.host",
    inbox: "0x56b6706d009db5357ee076e62c7c7e317e45c353",
    inboxDeployTx: "0x859f4c0aedc4e819ad3c4582f7f4793e5ee86cf3eae8caa6b23733c17d70d4ae",
    inboxFromBlock: 9_965_775n,
    explorer: "https://explore.qore.network",
    explorerNote: "switch the explorer's network to Testnet",
    restTx: (h) => `https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/${h}`,
  },
  mainnet: {
    name: "mainnet",
    chainId: "qorechain-vladi",
    evmChainId: 9801,
    rest: "https://api.qore.host",
    rpc: "https://rpc.qore.host",
    evmRpc: "https://evm.qore.host",
    explorer: "https://explore.qore.network",
    restTx: (h) => `https://api.qore.host/cosmos/tx/v1beta1/txs/${h}`,
  },
};

export function networkByName(name: string | undefined): Network {
  const n = (name ?? "testnet").toLowerCase();
  if (n === "testnet" || n === "diana") return NETWORKS.testnet;
  if (n === "mainnet" || n === "vladi") return NETWORKS.mainnet;
  throw new Error(`Unknown network "${name}". Use testnet or mainnet.`);
}

/** Same-origin gateway prefix used by the web app (vite.config.ts and server.mjs mount it). */
export const GATEWAY_PREFIX = "/chain";

/**
 * The chain's REST endpoint sends no CORS headers, so the browser reads it
 * through a small same-origin, GET-only gateway. The EVM JSON-RPC does send
 * CORS headers and is used directly.
 */
export function browserNetwork(name: Network["name"], origin: string): Network {
  const n = NETWORKS[name];
  return { ...n, rest: `${origin}${GATEWAY_PREFIX}/${name}/rest`, rpc: `${origin}${GATEWAY_PREFIX}/${name}/rpc` };
}
