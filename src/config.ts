export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const BASE_MAINNET = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";

export const USDC_SOLANA_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_SOLANA_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export const DEFAULT_SOLANA_PAY_TO = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";

export const PUBLIC_FACILITATOR_DEVNET = "https://x402.org/facilitator";
export const PUBLIC_FACILITATOR_MAINNET = "https://facilitator.payai.network";
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export const QUOTE_MINTS = new Set([
  SOL_MINT,
  USDC_SOLANA_MAINNET,
  USDC_SOLANA_DEVNET,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
]);

export const BLUECHIP_MINTS = new Set([
  ...QUOTE_MINTS,
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
]);

export type NetworkMode = "devnet" | "mainnet";
export type WalletCluster = "devnet" | "mainnet";

export type ChainAccept = {
  network: string;
  asset: string;
  payTo: string;
  chain: "solana" | "base";
  facilitator: "public" | "cdp";
};

export type AppEnv = {
  networkMode: NetworkMode;
  walletCluster: WalletCluster;
  port: number;
  publicBaseUrl?: string;
  solanaPayTo: string;
  evmPayTo?: string;
  solana: ChainAccept;
  base?: ChainAccept;
  publicFacilitatorUrl: string;
  cdpFacilitatorUrl: string;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  heliusApiKey?: string;
  jupiterApiKey?: string;
  birdeyeApiKey?: string;
  solanaRpcUrl: string;
  priceWalletProfile: string;
  priceTokenTrending: string;
  priceWalletFunding: string;
  priceWalletQuick: string;
  priceWalletQuickBatch: string;
};

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

export function usdToBaseUnits(price: string): string {
  const raw = price.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Price must look like $0.01, received ${price}`);
  }
  const [whole, frac = ""] = raw.split(".");
  const frac6 = `${frac}000000`.slice(0, 6);
  return (BigInt(whole) * 1_000_000n + BigInt(frac6)).toString();
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const networkMode: NetworkMode = source.X402_NETWORK === "mainnet" ? "mainnet" : "devnet";
  const walletCluster: WalletCluster = source.WALLET_CLUSTER === "devnet" ? "devnet" : "mainnet";
  const solanaPayTo = trimmed(source.SOLANA_PAY_TO) ?? DEFAULT_SOLANA_PAY_TO;
  const evmPayTo = trimmed(source.EVM_PAY_TO);
  const cdpApiKeyId = trimmed(source.CDP_API_KEY_ID);
  const cdpApiKeySecret = trimmed(source.CDP_API_KEY_SECRET);
  const useCdp = Boolean(cdpApiKeyId && cdpApiKeySecret);
  const publicFacilitatorUrl =
    trimmed(source.SOLANA_FACILITATOR_URL) ??
    trimmed(source.FACILITATOR_URL) ??
    (networkMode === "mainnet" ? PUBLIC_FACILITATOR_MAINNET : PUBLIC_FACILITATOR_DEVNET);

  const heliusApiKey = trimmed(source.HELIUS_API_KEY);
  const defaultRpc =
    walletCluster === "devnet"
      ? "https://api.devnet.solana.com"
      : heliusApiKey
        ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
        : "https://api.mainnet-beta.solana.com";

  const solana: ChainAccept = {
    chain: "solana",
    facilitator: "public",
    network: networkMode === "mainnet" ? SOLANA_MAINNET : SOLANA_DEVNET,
    asset: networkMode === "mainnet" ? USDC_SOLANA_MAINNET : USDC_SOLANA_DEVNET,
    payTo: solanaPayTo,
  };

  const base: ChainAccept | undefined = evmPayTo
    ? {
        chain: "base",
        facilitator: useCdp ? "cdp" : "public",
        network: networkMode === "mainnet" ? BASE_MAINNET : BASE_SEPOLIA,
        asset: networkMode === "mainnet" ? USDC_BASE_MAINNET : USDC_BASE_SEPOLIA,
        payTo: evmPayTo,
      }
    : undefined;

  return {
    networkMode,
    walletCluster,
    port: Number(source.PORT ?? 4021),
    publicBaseUrl: trimmed(source.PUBLIC_BASE_URL),
    solanaPayTo,
    evmPayTo,
    solana,
    base,
    publicFacilitatorUrl,
    cdpFacilitatorUrl: trimmed(source.CDP_FACILITATOR_URL) ?? CDP_FACILITATOR_URL,
    cdpApiKeyId,
    cdpApiKeySecret,
    heliusApiKey,
    jupiterApiKey: trimmed(source.JUPITER_API_KEY),
    birdeyeApiKey: trimmed(source.BIRDEYE_API_KEY),
    solanaRpcUrl: trimmed(source.SOLANA_RPC_URL) ?? defaultRpc,
    priceWalletProfile: trimmed(source.PRICE_WALLET_PROFILE) ?? "$0.009",
    priceTokenTrending: trimmed(source.PRICE_TOKEN_TRENDING) ?? "$0.0018",
    priceWalletFunding: trimmed(source.PRICE_WALLET_FUNDING) ?? "$0.009",
    priceWalletQuick: trimmed(source.PRICE_WALLET_QUICK) ?? "$0.002",
    priceWalletQuickBatch: trimmed(source.PRICE_WALLET_QUICK_BATCH) ?? "$0.015",
  };
}
