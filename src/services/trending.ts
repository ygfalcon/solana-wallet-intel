import { QUOTE_MINTS, type AppEnv } from "../config.js";
import { rankScore, riskFlags } from "../analytics.js";
import { fetchJson } from "../http.js";
import { createPublicRpc } from "../public-rpc.js";
import type { TokenChecks } from "../token-risk.js";
import { chooseLiquidPair, positiveUsd, type DexPair } from "./prices.js";
import { enrichTrendingTokens } from "./token-safety.js";

export type TrendingToken = {
  rank: number;
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
  checks?: TokenChecks;
};

export type TrendingResponse = {
  asOf: string;
  dataCluster: "mainnet";
  summary: string;
  tokens: TrendingToken[];
  sources: string[];
  warnings: string[];
  cached: boolean;
  stale: boolean;
};

type Boost = { chainId?: string; tokenAddress?: string };
type TrendingPair = DexPair & {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
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

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1) return Math.round(value * 100) / 100;
  if (value >= 0.01) return Math.round(value * 10_000) / 10_000;
  return Number(value.toPrecision(6));
}

function ageHours(pairCreatedAt?: number): number | null {
  if (pairCreatedAt == null || !Number.isFinite(pairCreatedAt) || pairCreatedAt <= 0) return null;
  const millis = pairCreatedAt < 1e12 ? pairCreatedAt * 1000 : pairCreatedAt;
  return Math.max(0, Math.round(((Date.now() - millis) / 3_600_000) * 10) / 10);
}

function compactUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function summarizeTrending(tokens: TrendingToken[]): string {
  if (tokens.length === 0) return "No trending Solana tokens were returned.";
  const flagged = tokens.filter((token) => token.riskFlags.length > 0).length;
  const top = tokens[0];
  const name = top.symbol ?? top.mint;
  const volume = top.volume24hUsd == null ? "unknown volume" : `${compactUsd(top.volume24hUsd)} 24h volume`;
  const liquidity = top.liquidityUsd == null ? "unknown liquidity" : `${compactUsd(top.liquidityUsd)} liquidity`;
  const noun = tokens.length === 1 ? "token" : "tokens";
  const flagVerb = flagged === 1 ? "has" : "have";
  return `${tokens.length} Solana ${noun}, ranked by 24h volume after down-ranking thin, new, and wash-like books. Top is ${name} with ${volume} and ${liquidity}. ${flagged} of ${tokens.length} ${flagVerb} risk flags.`;
}

function tokenFromPair(pair: TrendingPair, boosted: Set<string>): TrendingToken | null {
  const mint = pair.baseToken?.address;
  if (!mint || QUOTE_MINTS.has(mint)) return null;
  const token: TrendingToken = {
    rank: 0,
    mint,
    symbol: pair.baseToken?.symbol ?? null,
    name: pair.baseToken?.name ?? null,
    priceUsd: roundPrice(positiveUsd(pair.priceUsd)),
    liquidityUsd: roundMetric(positiveUsd(pair.liquidity?.usd) ?? (pair.liquidity?.usd === 0 ? 0 : null)),
    volume24hUsd: roundMetric(typeof pair.volume?.h24 === "number" ? pair.volume.h24 : null),
    priceChange24hPct: roundMetric(typeof pair.priceChange?.h24 === "number" ? pair.priceChange.h24 : null),
    ageHours: ageHours(pair.pairCreatedAt),
    pairAddress: pair.pairAddress ?? null,
    dex: pair.dexId ?? null,
    url: pair.url ?? null,
    riskFlags: [],
  };
  token.riskFlags = riskFlags({ ...token, boosted: boosted.has(mint) });
  return token;
}

export function assembleTrending(input: {
  pairs: TrendingPair[];
  boosted: Set<string>;
  birdeye: BirdeyeToken[];
  limit: number;
  sources: string[];
  warnings: string[];
}): Omit<TrendingResponse, "cached" | "stale"> {
  const grouped = new Map<string, TrendingPair[]>();
  for (const pair of input.pairs) {
    const mint = pair.baseToken?.address;
    if (!mint || QUOTE_MINTS.has(mint)) continue;
    if (pair.chainId && pair.chainId !== "solana") continue;
    const list = grouped.get(mint) ?? [];
    list.push(pair);
    grouped.set(mint, list);
  }

  const byMint = new Map<string, TrendingToken>();
  for (const [mint, pairs] of grouped) {
    const pair = chooseLiquidPair(pairs, mint);
    if (!pair) continue;
    const token = tokenFromPair(pair, input.boosted);
    if (token) byMint.set(mint, token);
  }

  for (const token of input.birdeye) {
    if (!token.address || QUOTE_MINTS.has(token.address) || byMint.has(token.address)) continue;
    const assembled: TrendingToken = {
      rank: 0,
      mint: token.address,
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      priceUsd: roundPrice(positiveUsd(token.price)),
      liquidityUsd: roundMetric(positiveUsd(token.liquidity) ?? (token.liquidity === 0 ? 0 : null)),
      volume24hUsd: roundMetric(positiveUsd(token.volume24hUSD) ?? (token.volume24hUSD === 0 ? 0 : null)),
      priceChange24hPct: roundMetric(
        typeof token.price24hChangePercent === "number" ? token.price24hChangePercent : null,
      ),
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
    .sort((a, b) => rankScore(b) - rankScore(a) || (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))
    .slice(0, input.limit)
    .map((token, index) => ({ ...token, rank: index + 1 }));

  return {
    asOf: new Date().toISOString(),
    dataCluster: "mainnet",
    summary: summarizeTrending(tokens),
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

  let pairs: TrendingPair[] = [];
  if (mints.length > 0) {
    pairs = await fetchJson<TrendingPair[]>(
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

  const assembled = assembleTrending({ pairs: pairs ?? [], boosted, birdeye, limit, sources, warnings });
  const tokens = await enrichTrendingTokens(assembled.tokens, createPublicRpc());
  return {
    ...assembled,
    tokens,
    summary: summarizeTrending(tokens),
    sources: [...assembled.sources, "public-solana-rpc"],
  };
}
