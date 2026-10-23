import type { AppEnv } from "../config.js";
import { riskFlags } from "../analytics.js";
import { fetchJson } from "../http.js";

export type TrendingToken = {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  ageHours: number | null;
  pairAddress: string | null;
  dex: string | null;
  url: string | null;
  riskFlags: string[];
};

export type TrendingResponse = {
  asOf: string;
  dataCluster: "mainnet";
  tokens: TrendingToken[];
  sources: string[];
  warnings: string[];
  cached: boolean;
  stale: boolean;
};

type Boost = { chainId?: string; tokenAddress?: string };
type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
};

type BirdeyeToken = {
  address?: string;
  symbol?: string;
  name?: string;
  liquidity?: number;
  volume24hUSD?: number;
  price?: number;
  price24hChangePercent?: number;
};

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : null;
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

export function assembleTrending(input: {
  pairs: DexPair[];
  boosted: Set<string>;
  birdeye: BirdeyeToken[];
  limit: number;
  sources: string[];
  warnings: string[];
}): Omit<TrendingResponse, "cached" | "stale"> {
  const byMint = new Map<string, TrendingToken>();

  for (const pair of input.pairs) {
    const mint = pair.baseToken?.address;
    if (!mint || pair.chainId && pair.chainId !== "solana") continue;
    const liquidityUsd = numberOrNull(pair.liquidity?.usd);
    const current = byMint.get(mint);
    if (current && (current.liquidityUsd ?? 0) > (liquidityUsd ?? 0)) continue;
    const ageHours = pair.pairCreatedAt ? Math.max(0, (Date.now() - pair.pairCreatedAt) / 3_600_000) : null;
    const token: TrendingToken = {
      mint,
      symbol: pair.baseToken?.symbol ?? null,
      name: pair.baseToken?.name ?? null,
      priceUsd: numberOrNull(pair.priceUsd),
      liquidityUsd,
      volume24hUsd: numberOrNull(pair.volume?.h24),
      priceChange24hPct: numberOrNull(pair.priceChange?.h24),
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      pairAddress: pair.pairAddress ?? null,
      dex: pair.dexId ?? null,
      url: pair.url ?? null,
      riskFlags: [],
    };
    token.riskFlags = riskFlags({ ...token, boosted: input.boosted.has(mint) });
    byMint.set(mint, token);
  }

  for (const token of input.birdeye) {
    if (!token.address || byMint.has(token.address)) continue;
    const assembled: TrendingToken = {
      mint: token.address,
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      priceUsd: numberOrNull(token.price),
      liquidityUsd: numberOrNull(token.liquidity),
      volume24hUsd: numberOrNull(token.volume24hUSD),
      priceChange24hPct: numberOrNull(token.price24hChangePercent),
      ageHours: null,
      pairAddress: null,
      dex: null,
      url: null,
      riskFlags: [],
    };
    assembled.riskFlags = riskFlags({ ...assembled, boosted: input.boosted.has(token.address) });
    byMint.set(token.address, assembled);
  }

  const tokens = [...byMint.values()]
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))
    .slice(0, input.limit);

  return {
    asOf: new Date().toISOString(),
    dataCluster: "mainnet",
    tokens,
    sources: input.sources,
    warnings: input.warnings,
  };
}

export async function loadTrending(env: AppEnv, limit: number): Promise<Omit<TrendingResponse, "cached" | "stale">> {
  const warnings: string[] = [];
  const sources = ["dexscreener"];
  const [top, latest] = await Promise.all([
    fetchJson<Boost[]>("https://api.dexscreener.com/token-boosts/top/v1", { source: "dexscreener" }),
    fetchJson<Boost[]>("https://api.dexscreener.com/token-boosts/latest/v1", { source: "dexscreener" }).catch(() => []),
  ]);
  const boostedMints = [...top, ...latest]
    .filter((item) => item.chainId === "solana" && item.tokenAddress)
    .map((item) => item.tokenAddress as string);
  const boosted = new Set(boostedMints);
  const mints = [...new Set(boostedMints)].slice(0, 30);
  if (mints.length === 0) warnings.push("DexScreener returned no boosted Solana tokens.");

  let pairs: DexPair[] = [];
  if (mints.length > 0) {
    pairs = await fetchJson<DexPair[]>(
      `https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`,
      { source: "dexscreener" },
    );
  }

  let birdeye: BirdeyeToken[] = [];
  if (env.birdeyeApiKey) {
    try {
      const body = await fetchJson<{ data?: { tokens?: BirdeyeToken[] } | BirdeyeToken[] }>(
        "https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20",
        {
          source: "birdeye",
          headers: { "X-API-KEY": env.birdeyeApiKey, "x-chain": "solana" },
        },
      );
      sources.push("birdeye");
      birdeye = Array.isArray(body.data) ? body.data : body.data?.tokens ?? [];
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Birdeye trending failed");
    }
  }

  return assembleTrending({ pairs: pairs ?? [], boosted, birdeye, limit, sources, warnings });
}
