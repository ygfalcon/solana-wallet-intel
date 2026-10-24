import { SOL_MINT } from "./solana.js";

export type RawHolding = {
  mint: string;
  amount: number;
  symbol: string | null;
  name: string | null;
  priceHint: number | null;
  decimals: number | null;
};

export type HoldingView = {
  mint: string;
  symbol: string | null;
  name: string | null;
  amount: number;
  usdValue: number | null;
  sharePct: number | null;
};

type TokenAmount = {
  uiAmountString?: string | null;
  uiAmount?: number | null;
  amount?: string | number | null;
  decimals?: number | null;
};

export function cleanAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const cleaned = Number(value.toPrecision(12));
  return Number.isFinite(cleaned) ? cleaned : 0;
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseUiAmount(token?: TokenAmount | null): { amount: number; decimals: number | null } {
  if (!token) return { amount: 0, decimals: null };
  const decimals = typeof token.decimals === "number" && Number.isFinite(token.decimals) ? token.decimals : null;
  if (token.uiAmountString != null && token.uiAmountString !== "") {
    const value = Number(token.uiAmountString);
    if (Number.isFinite(value)) return { amount: value, decimals };
  }
  if (typeof token.uiAmount === "number" && Number.isFinite(token.uiAmount)) return { amount: token.uiAmount, decimals };
  if (token.amount != null && decimals != null && decimals >= 0 && decimals <= 18) {
    const parsed = amountFromRaw(token.amount, decimals);
    if (parsed != null) return { amount: parsed, decimals };
  }
  return { amount: 0, decimals };
}

/** Divide an integer token amount in decimal scale without rounding through Number first. */
function amountFromRaw(amount: string | number, decimals: number): number | null {
  const text = String(amount).trim();
  if (!/^\d+$/.test(text)) return null;
  try {
    const raw = BigInt(text);
    const scale = 10n ** BigInt(decimals);
    const whole = raw / scale;
    const frac = raw % scale;
    const rendered = frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
    const value = Number(rendered);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function isLikelyNft(decimals: number | null | undefined, amount: number): boolean {
  return decimals === 0 && amount > 0 && amount <= 1 + 1e-9;
}

export type AssetLike = {
  id?: string;
  interface?: string;
  content?: { metadata?: { name?: string; symbol?: string } };
  token_info?: {
    balance?: number;
    decimals?: number;
    symbol?: string;
    price_info?: { price_per_token?: number };
  };
};

export function holdingFromAsset(item: AssetLike): RawHolding | null {
  const info = item.token_info;
  if (!item.id || !info || info.balance == null || info.decimals == null) return null;
  const iface = item.interface ?? "";
  const fungible = iface === "FungibleToken" || iface === "FungibleAsset" || info.decimals > 0;
  if (!fungible) return null;
  if (!Number.isFinite(info.balance) || !Number.isFinite(info.decimals) || info.decimals < 0) return null;
  const amount = info.balance / 10 ** info.decimals;
  if (!(amount > 0) || isLikelyNft(info.decimals, amount)) return null;
  const hint = info.price_info?.price_per_token;
  return {
    mint: item.id,
    amount,
    decimals: info.decimals,
    symbol: info.symbol ?? item.content?.metadata?.symbol ?? null,
    name: item.content?.metadata?.name ?? null,
    priceHint: hint != null && Number.isFinite(hint) && hint > 0 ? hint : null,
  };
}

export function nativeSolHolding(lamports: number): RawHolding | null {
  if (!Number.isFinite(lamports) || lamports <= 0) return null;
  return {
    mint: SOL_MINT,
    amount: lamports / 1_000_000_000,
    symbol: "SOL",
    name: "Solana",
    priceHint: null,
    decimals: 9,
  };
}

export function accumulateHoldings(items: RawHolding[]): RawHolding[] {
  const map = new Map<string, RawHolding>();
  for (const item of items) {
    if (!item.mint || !Number.isFinite(item.amount) || item.amount <= 0) continue;
    if (isLikelyNft(item.decimals, item.amount)) continue;
    const prior = map.get(item.mint);
    if (!prior) {
      map.set(item.mint, {
        mint: item.mint,
        amount: item.amount,
        symbol: item.symbol,
        name: item.name,
        priceHint: item.priceHint != null && item.priceHint > 0 ? item.priceHint : null,
        decimals: item.decimals,
      });
      continue;
    }
    prior.amount += item.amount;
    prior.symbol = prior.symbol ?? item.symbol;
    prior.name = prior.name ?? item.name;
    if (prior.priceHint == null && item.priceHint != null && item.priceHint > 0) prior.priceHint = item.priceHint;
    if (prior.decimals == null && item.decimals != null) prior.decimals = item.decimals;
  }
  return [...map.values()];
}

export function allocateShares(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 1000);
  const floors = exact.map((value) => Math.floor(value + 1e-9));
  let left = 1000 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  const tenths = [...floors];
  for (let cursor = 0; cursor < order.length && left > 0; cursor += 1) {
    tenths[order[cursor].index] += 1;
    left -= 1;
  }
  return tenths.map((value) => value / 10);
}

export function presentHoldings(rows: Array<Omit<HoldingView, "sharePct">>, limit = 12): {
  holdings: HoldingView[];
  portfolioUsd: number | null;
  pricedHoldings: number;
  omittedHoldings: number;
  unpricedHoldings: number;
} {
  const normalized = rows
    .map((row) => ({
      mint: row.mint,
      symbol: row.symbol,
      name: row.name,
      amount: cleanAmount(row.amount),
      usdValue: row.usdValue != null && Number.isFinite(row.usdValue) && row.usdValue > 0 ? row.usdValue : null,
    }))
    .filter((row) => row.amount > 0 && row.mint);

  const unpricedHoldings = normalized.filter((row) => row.usdValue == null).length;
  const priced = normalized.filter((row) => row.usdValue != null);
  const portfolioRaw = priced.reduce((sum, row) => sum + (row.usdValue ?? 0), 0);
  const portfolioUsd = priced.length > 0 ? roundUsd(portfolioRaw) : null;
  const shares = allocateShares(priced.map((row) => row.usdValue ?? 0));
  const shareByMint = new Map<string, number>();
  priced.forEach((row, index) => shareByMint.set(row.mint, shares[index] ?? 0));

  const sorted = [...normalized].sort((a, b) => {
    const left = a.usdValue ?? -1;
    const right = b.usdValue ?? -1;
    if (right !== left) return right - left;
    return b.amount - a.amount;
  });
  const shown = sorted.slice(0, Math.max(0, limit)).map((row) => ({
    ...row,
    usdValue: row.usdValue == null ? null : roundUsd(row.usdValue),
    sharePct: row.usdValue == null ? null : shareByMint.get(row.mint) ?? null,
  }));

  return {
    holdings: shown,
    portfolioUsd,
    pricedHoldings: priced.length,
    omittedHoldings: Math.max(0, normalized.length - shown.length),
    unpricedHoldings,
  };
}
