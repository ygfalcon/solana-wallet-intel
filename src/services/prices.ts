import { QUOTE_MINTS, type AppEnv } from "../config.js";
import { fetchJson } from "../http.js";
import { SOL_MINT } from "../solana.js";

type JupiterPrice = { usdPrice?: number; decimals?: number };

export type DexPair = {
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
};

export type TokenMeta = { symbol: string | null; name: string | null; priceUsd: number | null };

export function positiveUsd(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : null;
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function isMajorQuote(pair: DexPair): boolean {
  const address = pair.quoteToken?.address;
  if (address && QUOTE_MINTS.has(address)) return true;
  const symbol = (pair.quoteToken?.symbol ?? "").toUpperCase();
  return symbol === "SOL" || symbol === "USDC" || symbol === "USDT" || symbol === "PYUSD";
}

export function chooseLiquidPair<T extends DexPair>(pairs: T[], mint: string): T | null {
  const matching = pairs.filter((pair) => pair.baseToken?.address === mint);
  if (matching.length === 0) return null;
  const major = matching.filter((pair) => isMajorQuote(pair));
  const pool = major.length > 0 ? major : matching;
  return pool.reduce((best, pair) => ((pair.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? pair : best));
}

export async function loadTokenMeta(
  env: AppEnv,
  mints: string[],
): Promise<{ meta: Map<string, TokenMeta>; sources: string[] }> {
  const unique = [...new Set(mints.filter(Boolean))];
  const meta = new Map<string, TokenMeta>();
  const sources: string[] = [];
  if (unique.length === 0) return { meta, sources };

  const headers: Record<string, string> = {};
  if (env.jupiterApiKey) headers["x-api-key"] = env.jupiterApiKey;

  for (let index = 0; index < unique.length; index += 50) {
    const chunk = unique.slice(index, index + 50);
    try {
      const body = await fetchJson<Record<string, JupiterPrice>>(
        `https://api.jup.ag/price/v3?ids=${chunk.join(",")}`,
        { source: "jupiter", headers },
      );
      sources.push("jupiter");
      for (const mint of chunk) {
        meta.set(mint, {
          symbol: mint === SOL_MINT ? "SOL" : null,
          name: mint === SOL_MINT ? "Solana" : null,
          priceUsd: positiveUsd(body[mint]?.usdPrice),
        });
      }
    } catch {
      for (const mint of chunk) {
        if (!meta.has(mint)) {
          meta.set(mint, { symbol: mint === SOL_MINT ? "SOL" : null, name: mint === SOL_MINT ? "Solana" : null, priceUsd: null });
        }
      }
    }
  }

  const missing = unique.filter((mint) => meta.get(mint)?.priceUsd == null || meta.get(mint)?.symbol == null);
  for (let index = 0; index < missing.length; index += 30) {
    const chunk = missing.slice(index, index + 30);
    try {
      const pairs = await fetchJson<DexPair[]>(
        `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`,
        { source: "dexscreener" },
      );
      sources.push("dexscreener");
      for (const mint of chunk) {
        const pair = chooseLiquidPair(pairs ?? [], mint);
        if (!pair) continue;
        const prior = meta.get(mint) ?? { symbol: null, name: null, priceUsd: null };
        meta.set(mint, {
          symbol: prior.symbol ?? pair.baseToken?.symbol ?? null,
          name: prior.name ?? pair.baseToken?.name ?? null,
          priceUsd: prior.priceUsd ?? positiveUsd(pair.priceUsd),
        });
      }
    } catch {
      // Price coverage is best-effort. Callers mark missing USD values as null.
    }
  }

  return { meta, sources: [...new Set(sources)] };
}
