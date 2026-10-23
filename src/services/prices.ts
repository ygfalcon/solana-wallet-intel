import type { AppEnv } from "../config.js";
import { fetchJson } from "../http.js";
import { SOL_MINT } from "../solana.js";

type JupiterPrice = { usdPrice?: number; decimals?: number; liquidity?: number };

type DexPair = {
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
};

export type TokenMeta = { symbol: string | null; name: string | null; priceUsd: number | null; liquidityUsd?: number | null };

// Warm-instance price cache (short TTL) so repeat calls within a minute use identical prices.
const PRICE_TTL_MS = 60_000;
const priceCache = new Map<string, { at: number; meta: TokenMeta }>();
export function clearPriceCache() { priceCache.clear(); }

export async function loadTokenMeta(env: AppEnv, mints: string[], dexMints?: string[]): Promise<Map<string, TokenMeta>> {
  const dexAllow = new Set(dexMints ?? mints);
  const all = [...new Set(mints.filter(Boolean))];
  const meta = new Map<string, TokenMeta>();
  const now = Date.now();
  for (const mint of all) {
    const hit = priceCache.get(mint);
    if (hit && now - hit.at < PRICE_TTL_MS) meta.set(mint, hit.meta);
  }
  const unique = all.filter((m) => !meta.has(m));
  if (unique.length === 0) return meta;
  const fresh = new Set<string>();

  const headers: Record<string, string> = {};
  if (env.jupiterApiKey) headers["x-api-key"] = env.jupiterApiKey;

  const jupChunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 50) jupChunks.push(unique.slice(i, i + 50));
  await pool(jupChunks, 5, async (chunk) => {
    try {
      const url = `https://${env.jupiterApiKey ? "api" : "lite-api"}.jup.ag/price/v3?ids=${chunk.join(",")}`;
      const body = await fetchJson<Record<string, JupiterPrice>>(url, { source: "jupiter", headers, timeoutMs: 4_000 })
        .catch(() => fetchJson<Record<string, JupiterPrice>>(url, { source: "jupiter", headers, timeoutMs: 4_000 }));
      for (const mint of chunk) {
        const price = body[mint]?.usdPrice;
        meta.set(mint, {
          symbol: mint === SOL_MINT ? "SOL" : null,
          name: mint === SOL_MINT ? "Solana" : null,
          priceUsd: typeof price === "number" ? price : null,
          liquidityUsd: typeof body[mint]?.liquidity === "number" ? body[mint]!.liquidity! : null,
        });
        fresh.add(mint);
      }
    } catch {
      for (const mint of chunk) {
        if (!meta.has(mint)) meta.set(mint, { symbol: mint === SOL_MINT ? "SOL" : null, name: null, priceUsd: null });
      }
    }
  });

  // DexScreener fallback: cap at 90 mints (priority order = caller order) and run in parallel to keep latency low.
  const missing = unique.filter((mint) => dexAllow.has(mint) && (meta.get(mint)?.priceUsd == null || meta.get(mint)?.symbol == null)).slice(0, 60);
  const dexChunks: string[][] = [];
  for (let i = 0; i < missing.length; i += 30) dexChunks.push(missing.slice(i, i + 30));
  await pool(dexChunks, 5, async (chunk) => {
    try {
      const pairs = await fetchJson<DexPair[]>(
        `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`,
        { source: "dexscreener" },
      );
      const best = new Map<string, DexPair>();
      for (const pair of pairs ?? []) {
        const mint = pair.baseToken?.address;
        if (!mint) continue;
        const current = best.get(mint);
        if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(mint, pair);
      }
      for (const [mint, pair] of best) {
        const prior = meta.get(mint) ?? { symbol: null, name: null, priceUsd: null };
        const parsed = pair.priceUsd ? Number(pair.priceUsd) : null;
        meta.set(mint, {
          symbol: prior.symbol ?? pair.baseToken?.symbol ?? null,
          name: prior.name ?? pair.baseToken?.name ?? null,
          priceUsd: prior.priceUsd ?? (parsed !== null && Number.isFinite(parsed) ? parsed : null),
          liquidityUsd: prior.liquidityUsd ?? pair.liquidity?.usd ?? null,
        });
      }
    } catch {
      // Price coverage is best-effort. Callers mark missing USD values as null.
    }
  });

  // Only cache mints whose Jupiter chunk succeeded, so a transient failure is retried next call.
  for (const mint of fresh) { const m = meta.get(mint); if (m) priceCache.set(mint, { at: now, meta: m }); }
  return meta;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}
