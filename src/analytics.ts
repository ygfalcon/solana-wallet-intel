import { BLUECHIP_MINTS, QUOTE_MINTS } from "./config.js";
import { SOL_MINT } from "./solana.js";

export type TradeLeg = { mint: string; delta: number };

export type PnlEstimate = {
  method: "window_average_cost_current_prices";
  disclaimer: string;
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  closedTrades: number;
  winningTrades: number;
  winRate: number | null;
  partialCostBasis: boolean;
};

export type HoldingInput = {
  mint: string;
  symbol: string | null;
  amount: number;
  usdValue: number | null;
};

const DISCLAIMER =
  "PnL uses the fetched transaction window and current USD prices as a cost proxy. It is not tax-grade and misses trades outside the window.";

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function estimatePnl(trades: TradeLeg[][], prices: Map<string, number>): PnlEstimate {
  const lots = new Map<string, { qty: number; costUsd: number }>();
  let realized = 0;
  let closed = 0;
  let wins = 0;
  let partial = false;
  let priced = false;

  for (const legs of trades) {
    const spentQuoteUsd = legs
      .filter((leg) => leg.delta < 0 && QUOTE_MINTS.has(leg.mint))
      .reduce((sum, leg) => sum + Math.abs(leg.delta) * (prices.get(leg.mint) ?? 0), 0);
    const receivedQuoteUsd = legs
      .filter((leg) => leg.delta > 0 && QUOTE_MINTS.has(leg.mint))
      .reduce((sum, leg) => sum + leg.delta * (prices.get(leg.mint) ?? 0), 0);
    const bought = legs.filter((leg) => leg.delta > 0 && !QUOTE_MINTS.has(leg.mint));
    const sold = legs.filter((leg) => leg.delta < 0 && !QUOTE_MINTS.has(leg.mint));
    if (bought.length === 0 && sold.length === 0) continue;

    const boughtQty = bought.reduce((sum, leg) => sum + leg.delta, 0);
    if (boughtQty > 0 && spentQuoteUsd > 0) {
      priced = true;
      for (const leg of bought) {
        const share = leg.delta / boughtQty;
        const lot = lots.get(leg.mint) ?? { qty: 0, costUsd: 0 };
        lot.qty += leg.delta;
        lot.costUsd += spentQuoteUsd * share;
        lots.set(leg.mint, lot);
      }
    }

    for (const leg of sold) {
      const qty = Math.abs(leg.delta);
      const lot = lots.get(leg.mint) ?? { qty: 0, costUsd: 0 };
      const knownQty = Math.min(qty, lot.qty);
      const unknownQty = qty - knownQty;
      if (unknownQty > 0.0000001) partial = true;
      const avg = lot.qty > 0 ? lot.costUsd / lot.qty : (prices.get(leg.mint) ?? 0);
      const proceeds =
        receivedQuoteUsd > 0
          ? receivedQuoteUsd * (qty / sold.reduce((sum, item) => sum + Math.abs(item.delta), 0))
          : qty * (prices.get(leg.mint) ?? 0);
      // Only score the portion with a known cost basis inside the window; unknown-cost sells
      // would otherwise be valued at today's (often ~0) price and fake huge wins.
      if (knownQty <= 0) continue;
      const knownProceeds = proceeds * (knownQty / qty);
      const pnl = knownProceeds - knownQty * avg;
      if (Number.isFinite(pnl)) {
        priced = true;
        realized += pnl;
        if (Math.abs(pnl) >= 0.01) {
          closed += 1;
          if (pnl > 0) wins += 1;
        }
      }
      if (knownQty > 0) {
        lot.costUsd -= avg * knownQty;
        lot.qty -= knownQty;
        if (lot.qty <= 0.0000001) lots.delete(leg.mint);
        else lots.set(leg.mint, lot);
      }
    }
  }

  let unrealized = 0;
  let unrealizedPriced = false;
  for (const [mint, lot] of lots) {
    const price = prices.get(mint);
    if (price === undefined || lot.qty <= 0) continue;
    unrealizedPriced = true;
    unrealized += lot.qty * price - lot.costUsd;
  }

  return {
    method: "window_average_cost_current_prices",
    disclaimer: DISCLAIMER,
    realizedUsd: priced ? roundUsd(realized) : null,
    unrealizedUsd: unrealizedPriced ? roundUsd(unrealized) : null,
    closedTrades: closed,
    winningTrades: wins,
    winRate: closed > 0 ? Math.round((wins / closed) * 1000) / 1000 : null,
    partialCostBasis: partial,
  };
}

export function labelWallet(input: {
  swapCount: number;
  lastActiveAt: string | null;
  holdings: HoldingInput[];
  memecoinSwaps: number;
  pnl: PnlEstimate;
  times?: number[];
}): string[] {
  const labels: string[] = [];
  const portfolio = input.holdings.reduce((sum, holding) => sum + (holding.usdValue ?? 0), 0);
  const bluechipUsd = input.holdings
    .filter((holding) => BLUECHIP_MINTS.has(holding.mint) || holding.mint === SOL_MINT)
    .reduce((sum, holding) => sum + (holding.usdValue ?? 0), 0);
  const stableUsd = input.holdings
    .filter((holding) => QUOTE_MINTS.has(holding.mint) && holding.mint !== SOL_MINT)
    .reduce((sum, holding) => sum + (holding.usdValue ?? 0), 0);
  const top = [...input.holdings].sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))[0];
  const dormant =
    !input.lastActiveAt || Date.now() - Date.parse(input.lastActiveAt) > 14 * 24 * 60 * 60 * 1000;

  if (dormant) labels.push("dormant");
  if (input.memecoinSwaps >= 4) labels.push("active memecoin trader");
  if (portfolio > 0 && bluechipUsd / portfolio >= 0.7) labels.push("blue-chip holder");
  if (portfolio > 0 && stableUsd / portfolio >= 0.8) labels.push("stablecoin heavy");
  if (input.swapCount >= 12) labels.push("high turnover");
  if (portfolio > 0 && top?.usdValue && top.usdValue / portfolio >= 0.75) labels.push("concentrated book");
  if ((input.pnl.realizedUsd ?? 0) >= 1 && input.pnl.winningTrades > 0) labels.push("net winner");
  if ((input.pnl.realizedUsd ?? 0) <= -1) labels.push("net loser");
  const times = [...(input.times ?? [])].sort((a, b) => a - b);
  if (times.length >= 15) {
    const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median <= 15) labels.push(input.swapCount === 0 && portfolio >= 10_000_000 ? "exchange or custodial wallet" : "bot-like cadence");
  }
  if (input.pnl.closedTrades >= 5 && (input.pnl.winRate ?? 0) >= 0.6 && (input.pnl.realizedUsd ?? 0) >= 500) {
    labels.push("smart-money candidate");
  }
  if (labels.length === 0) labels.push(input.swapCount > 0 ? "light activity" : "holder");
  return labels;
}

export type RiskToken = {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  ageHours: number | null;
  priceChange24hPct: number | null;
  boosted: boolean;
};

export function riskFlags(token: RiskToken): string[] {
  const flags: string[] = [];
  if (token.liquidityUsd !== null && token.liquidityUsd < 15_000) flags.push("low_liquidity");
  if (token.volume24hUsd !== null && token.volume24hUsd < 8_000) flags.push("thin_volume");
  if (token.ageHours !== null && token.ageHours < 24) flags.push("newly_launched");
  if (token.priceChange24hPct !== null && Math.abs(token.priceChange24hPct) > 80) flags.push("extreme_move");
  if (
    token.liquidityUsd !== null &&
    token.volume24hUsd !== null &&
    token.liquidityUsd > 0 &&
    token.volume24hUsd > token.liquidityUsd * 8
  ) {
    flags.push("wash_suspect");
  }
  if (token.boosted) flags.push("paid_boost");
  return flags;
}
