import { BLUECHIP_MINTS, QUOTE_MINTS } from "./config.js";
import { SOL_MINT } from "./solana.js";

export type TradeLeg = { mint: string; delta: number; usdPrice?: number | null };

export type TradeEvent = { at?: number | null; legs: TradeLeg[] };

export type PriceBasis = "current_spot" | "execution" | "mixed" | "unavailable";

export type PnlEstimate = {
  method: "window_average_cost_current_prices" | "window_average_cost_execution_prices";
  priceBasis: PriceBasis;
  disclaimer: string;
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  closedTrades: number;
  winningTrades: number;
  winRate: number | null;
  partialCostBasis: boolean;
  unpricedSells: number;
};

export type HoldingInput = {
  mint: string;
  symbol: string | null;
  amount: number;
  usdValue: number | null;
  sharePct?: number | null;
};

export type LabelDetail = {
  id: string;
  title: string;
  category: "activity" | "portfolio" | "performance" | "risk";
  confidence: "high" | "medium" | "low";
  evidence: string;
};

export type LabelInput = {
  swapCount: number;
  lastActiveAt: string | null;
  holdings: HoldingInput[];
  memecoinSwaps: number;
  pnl: PnlEstimate;
  firstActiveAt?: string | null;
  historyTruncated?: boolean;
  medianSwapGapSeconds?: number | null;
  signatureCount?: number;
};

const DISCLAIMER =
  "PnL is average cost over the fetched transaction window, not a full tax-lot history. Stablecoins are pegged near $1. SOL used as payment is valued at the trade-hour price when that history exists, otherwise at the current SOL price. Transfers are not sales. Sells with no in-window cost basis are excluded instead of marked at the current token price.";

const LST_MINTS = new Set([
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

type Lot = { qty: number; costUsd: number };
type BasisKind = "execution" | "current_spot" | "peg" | "missing";

export function isStableMint(mint: string): boolean {
  return QUOTE_MINTS.has(mint) && mint !== SOL_MINT;
}

export function netLegs(legs: TradeLeg[]): TradeLeg[] {
  const byMint = new Map<string, { delta: number; usdPrice: number | null; weight: number }>();
  for (const leg of legs) {
    if (!leg?.mint || !Number.isFinite(leg.delta) || leg.delta === 0) continue;
    const current = byMint.get(leg.mint) ?? { delta: 0, usdPrice: null, weight: 0 };
    const size = Math.abs(leg.delta);
    const price = positive(leg.usdPrice);
    if (price != null) {
      const nextWeight = current.weight + size;
      current.usdPrice =
        current.usdPrice == null ? price : (current.usdPrice * current.weight + price * size) / nextWeight;
      current.weight = nextWeight;
    }
    current.delta += leg.delta;
    byMint.set(leg.mint, current);
  }
  return [...byMint.entries()]
    .filter(([, value]) => Math.abs(value.delta) > 1e-12)
    .map(([mint, value]) => ({
      mint,
      delta: value.delta,
      ...(value.usdPrice != null ? { usdPrice: value.usdPrice } : {}),
    }));
}

export function isTwoSided(legs: TradeLeg[]): boolean {
  const nets = netLegs(legs);
  return nets.some((leg) => leg.delta > 0) && nets.some((leg) => leg.delta < 0);
}

export function isSpeculativeSwap(legs: TradeLeg[]): boolean {
  const nets = netLegs(legs);
  if (!isTwoSided(nets)) return false;
  return nets.some((leg) => !BLUECHIP_MINTS.has(leg.mint));
}

export function medianGapSeconds(times: number[]): number | null {
  const sorted = times.filter((time) => Number.isFinite(time)).sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  const gaps = [];
  for (let index = 1; index < sorted.length; index += 1) gaps.push(sorted[index] - sorted[index - 1]);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function unitPrice(leg: TradeLeg, prices: Map<string, number>): { price: number; basis: BasisKind } {
  if (isStableMint(leg.mint)) {
    const quoted = positive(leg.usdPrice) ?? positive(prices.get(leg.mint));
    if (quoted != null && quoted >= 0.95 && quoted <= 1.05) {
      return { price: quoted, basis: leg.usdPrice != null ? "execution" : "peg" };
    }
    return { price: 1, basis: "peg" };
  }
  const execution = positive(leg.usdPrice);
  if (execution != null) return { price: execution, basis: "execution" };
  const spot = positive(prices.get(leg.mint));
  if (spot != null) return { price: spot, basis: "current_spot" };
  return { price: 0, basis: "missing" };
}

function weightsFor(legs: TradeLeg[], prices: Map<string, number>): { weights: number[]; valued: boolean } {
  if (legs.length === 1) return { weights: [1], valued: true };
  const values = legs.map((leg) => {
    const price = positive(leg.usdPrice) ?? positive(prices.get(leg.mint));
    return price == null ? 0 : Math.abs(leg.delta) * price;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total > 0) return { weights: values.map((value) => value / total), valued: true };
  const quantity = legs.reduce((sum, leg) => sum + Math.abs(leg.delta), 0);
  return {
    weights: legs.map((leg) => (quantity > 0 ? Math.abs(leg.delta) / quantity : 0)),
    valued: false,
  };
}

type NormEvent = { at: number | null; legs: TradeLeg[]; index: number };

function normalizeTrades(trades: Array<TradeLeg[] | TradeEvent>): NormEvent[] {
  const events = trades.map((trade, index) => {
    if (Array.isArray(trade)) return { at: null, legs: trade, index };
    return { at: trade.at ?? null, legs: trade.legs ?? [], index };
  });
  events.sort((left, right) => {
    if (left.at != null && right.at != null && left.at !== right.at) return left.at - right.at;
    if (left.at != null && right.at == null) return -1;
    if (left.at == null && right.at != null) return 1;
    return left.index - right.index;
  });
  return events;
}

export function estimatePnl(trades: Array<TradeLeg[] | TradeEvent>, prices: Map<string, number>): PnlEstimate {
  const lots = new Map<string, Lot>();
  let realized = 0;
  let closed = 0;
  let wins = 0;
  let partial = false;
  let priced = false;
  let unpricedSells = 0;
  let sawExecution = false;
  let sawSpot = false;

  const note = (basis: BasisKind) => {
    if (basis === "execution" || basis === "peg") sawExecution = true;
    if (basis === "current_spot") sawSpot = true;
  };

  const putLot = (mint: string, lot: Lot) => {
    if (lot.qty <= 1e-9) lots.delete(mint);
    else lots.set(mint, lot);
  };

  const acquire = (mint: string, qty: number, costUsd: number) => {
    if (qty <= 1e-12 || costUsd < 0) return;
    const lot = lots.get(mint) ?? { qty: 0, costUsd: 0 };
    lot.qty += qty;
    lot.costUsd += costUsd;
    putLot(mint, lot);
    priced = true;
  };

  const removeAtCost = (mint: string, qty: number) => {
    const lot = lots.get(mint);
    if (!lot || lot.qty <= 1e-12) return;
    const known = Math.min(qty, lot.qty);
    const avg = lot.costUsd / lot.qty;
    lot.qty -= known;
    lot.costUsd -= avg * known;
    putLot(mint, lot);
  };

  const consume = (mint: string, qty: number, executionPrice: number) => {
    const lot = lots.get(mint);
    if (!lot || lot.qty <= 1e-12) return { realized: 0, knownQty: 0, shortfall: false };
    const known = Math.min(qty, lot.qty);
    const avg = lot.costUsd / lot.qty;
    const pnl = known * (executionPrice - avg);
    const shortfall = qty - known > 1e-8;
    lot.qty -= known;
    lot.costUsd -= avg * known;
    putLot(mint, lot);
    priced = true;
    return { realized: pnl, knownQty: known, shortfall };
  };

  const bookClose = (pnl: number) => {
    if (!Number.isFinite(pnl)) return;
    realized += pnl;
    priced = true;
    if (Math.abs(pnl) >= 0.01) {
      closed += 1;
      if (pnl > 0) wins += 1;
    }
  };

  for (const event of normalizeTrades(trades)) {
    const legs = netLegs(event.legs);
    if (legs.length === 0) continue;

    let stableDeltaUsd = 0;
    for (const leg of legs.filter((item) => isStableMint(item.mint))) {
      const pricedLeg = unitPrice(leg, prices);
      note(pricedLeg.basis);
      stableDeltaUsd += leg.delta * pricedLeg.price;
    }

    const solLeg = legs.find((leg) => leg.mint === SOL_MINT);
    const solDelta = solLeg?.delta ?? 0;
    let solUnit = 0;
    if (solLeg && Math.abs(solDelta) > 1e-12) {
      const pricedLeg = unitPrice(solLeg, prices);
      note(pricedLeg.basis);
      solUnit = pricedLeg.price;
    }
    const solUsdAbs = Math.abs(solDelta) * solUnit;

    const tokenLegs = legs.filter((leg) => !QUOTE_MINTS.has(leg.mint));
    const incoming = tokenLegs.filter((leg) => leg.delta > 0);
    const outgoing = tokenLegs.filter((leg) => leg.delta < 0);
    const solFlow = Math.abs(solDelta) >= 1e-8;

    if (tokenLegs.length === 0) {
      if (solFlow && solDelta > 0 && stableDeltaUsd < -0.0001) acquire(SOL_MINT, solDelta, Math.abs(stableDeltaUsd));
      else if (solFlow && solDelta < 0 && stableDeltaUsd > 0.0001) {
        const execution = stableDeltaUsd / Math.abs(solDelta);
        const consumed = consume(SOL_MINT, Math.abs(solDelta), execution);
        if (consumed.shortfall) partial = true;
        if (consumed.knownQty > 0) bookClose(consumed.realized);
        else {
          partial = true;
          unpricedSells += 1;
        }
      } else if (solFlow && solDelta < 0) removeAtCost(SOL_MINT, Math.abs(solDelta));
      continue;
    }

    let spentQuoteUsd = stableDeltaUsd < 0 ? -stableDeltaUsd : 0;
    let receivedQuoteUsd = stableDeltaUsd > 0 ? stableDeltaUsd : 0;

    if (solDelta < 0 && solUsdAbs > 0) {
      spentQuoteUsd += solUsdAbs;
      const consumed = consume(SOL_MINT, Math.abs(solDelta), solUnit);
      if (consumed.shortfall) partial = true;
      if (consumed.knownQty > 0) bookClose(consumed.realized);
    }
    if (solDelta > 0 && solUsdAbs > 0) receivedQuoteUsd += solUsdAbs;

    if (spentQuoteUsd <= 0 && receivedQuoteUsd <= 0 && incoming.length > 0 && outgoing.length > 0) {
      let transfer = 0;
      for (const leg of outgoing) {
        const pricedLeg = unitPrice(leg, prices);
        note(pricedLeg.basis);
        transfer += Math.abs(leg.delta) * pricedLeg.price;
      }
      if (transfer > 0) {
        spentQuoteUsd = transfer;
        receivedQuoteUsd = transfer;
      }
    }

    const sale = outgoing.length > 0 && receivedQuoteUsd > 0.0001;
    const transferOut = outgoing.length > 0 && !sale && incoming.length === 0;
    if (transferOut) {
      for (const leg of outgoing) removeAtCost(leg.mint, Math.abs(leg.delta));
    } else if (sale) {
      const weighted = weightsFor(outgoing, prices);
      if (!weighted.valued) partial = true;
      outgoing.forEach((leg, index) => {
        const qty = Math.abs(leg.delta);
        const lot = lots.get(leg.mint);
        const known = Math.min(qty, lot?.qty ?? 0);
        if (known <= 1e-9 || !lot) {
          partial = true;
          unpricedSells += 1;
          return;
        }
        const avg = lot.costUsd / lot.qty;
        const proceeds = receivedQuoteUsd * weighted.weights[index] * (known / qty);
        lot.qty -= known;
        lot.costUsd -= avg * known;
        putLot(leg.mint, lot);
        if (qty - known > 1e-8) {
          partial = true;
          unpricedSells += 1;
        }
        bookClose(proceeds - known * avg);
      });
    }

    if (incoming.length > 0 && spentQuoteUsd > 0.0001) {
      const weighted = weightsFor(incoming, prices);
      if (!weighted.valued) partial = true;
      incoming.forEach((leg, index) => acquire(leg.mint, leg.delta, spentQuoteUsd * weighted.weights[index]));
    }

    if (solDelta > 0 && solUsdAbs > 0) acquire(SOL_MINT, solDelta, solUsdAbs);
  }

  let unrealized = 0;
  let unrealizedPriced = false;
  for (const [mint, lot] of lots) {
    if (lot.qty <= 1e-9) continue;
    const price = isStableMint(mint) ? 1 : positive(prices.get(mint));
    if (price == null) {
      partial = true;
      continue;
    }
    unrealizedPriced = true;
    unrealized += lot.qty * price - lot.costUsd;
  }

  const priceBasis: PriceBasis = !sawExecution && !sawSpot
    ? "unavailable"
    : sawExecution && sawSpot
      ? "mixed"
      : sawSpot
        ? "current_spot"
        : "execution";

  return {
    method:
      priceBasis === "current_spot" || priceBasis === "unavailable"
        ? "window_average_cost_current_prices"
        : "window_average_cost_execution_prices",
    priceBasis,
    disclaimer: DISCLAIMER,
    realizedUsd: priced ? roundUsd(realized) : null,
    unrealizedUsd: unrealizedPriced ? roundUsd(unrealized) : null,
    closedTrades: closed,
    winningTrades: wins,
    winRate: closed > 0 ? Math.round((wins / closed) * 1000) / 1000 : null,
    partialCostBasis: partial,
    unpricedSells,
  };
}

function money(value: number, digits = 2): string {
  return `$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function signedMoney(value: number): string {
  if (value > 0) return `+${money(value)}`;
  if (value < 0) return `-${money(value)}`;
  return money(0);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function describeWallet(input: LabelInput): { labels: string[]; details: LabelDetail[] } {
  const labels: string[] = [];
  const details: LabelDetail[] = [];
  const add = (detail: LabelDetail) => {
    details.push(detail);
    labels.push(detail.title);
  };

  const portfolio = input.holdings.reduce((sum, holding) => sum + (holding.usdValue ?? 0), 0);
  const pricedHoldings = input.holdings.filter((holding) => (holding.usdValue ?? 0) > 0);
  const bluechipUsd = input.holdings
    .filter((holding) => BLUECHIP_MINTS.has(holding.mint) && !isStableMint(holding.mint))
    .reduce((sum, holding) => sum + (holding.usdValue ?? 0), 0);
  const stableUsd = input.holdings
    .filter((holding) => isStableMint(holding.mint))
    .reduce((sum, holding) => sum + (holding.usdValue ?? 0), 0);
  const lstUsd = input.holdings
    .filter((holding) => LST_MINTS.has(holding.mint))
    .reduce((sum, holding) => sum + (holding.usdValue ?? 0), 0);
  const top = [...pricedHoldings].sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))[0];
  const lastActiveMs = input.lastActiveAt ? Date.parse(input.lastActiveAt) : Number.NaN;
  const dormant = Number.isFinite(lastActiveMs) && Date.now() - lastActiveMs > 14 * DAY_MS;
  const signatureCount = input.signatureCount ?? 0;
  const noFlow = !input.lastActiveAt && input.swapCount === 0 && signatureCount === 0;

  if (noFlow && portfolio <= 0 && input.holdings.length === 0) {
    add({
      id: "no_onchain_activity",
      title: "no on-chain activity",
      category: "activity",
      confidence: "high",
      evidence: "The fetched window has no transactions and the wallet has no priced holdings.",
    });
  } else if (dormant) {
    const days = Math.floor((Date.now() - lastActiveMs) / DAY_MS);
    add({
      id: "dormant",
      title: "dormant",
      category: "activity",
      confidence: "high",
      evidence: `Last transaction in the window was ${days} days ago.`,
    });
  }

  if (!noFlow && !dormant && input.memecoinSwaps >= 4) {
    add({
      id: "active_memecoin_trader",
      title: "active memecoin trader",
      category: "activity",
      confidence: "medium",
      evidence: `${input.memecoinSwaps} swaps traded a token outside the blue-chip and stablecoin set.`,
    });
  }
  if (!noFlow && !dormant && input.swapCount >= 12) {
    add({
      id: "high_turnover",
      title: "high turnover",
      category: "activity",
      confidence: "medium",
      evidence: `${input.swapCount} two-sided swaps in the fetched window.`,
    });
  }
  if (
    !noFlow &&
    !dormant &&
    input.swapCount >= 8 &&
    input.medianSwapGapSeconds != null &&
    input.medianSwapGapSeconds <= 90
  ) {
    add({
      id: "bot_like",
      title: "bot-like",
      category: "risk",
      confidence: "medium",
      evidence: `Median gap between swaps is ${Math.round(input.medianSwapGapSeconds)} seconds across ${input.swapCount} swaps.`,
    });
  }
  const firstMs = input.firstActiveAt ? Date.parse(input.firstActiveAt) : Number.NaN;
  if (
    input.historyTruncated === false &&
    Number.isFinite(firstMs) &&
    !dormant &&
    Date.now() - firstMs <= 7 * DAY_MS &&
    (input.swapCount > 0 || signatureCount > 0)
  ) {
    add({
      id: "fresh_wallet",
      title: "fresh wallet",
      category: "activity",
      confidence: "medium",
      evidence: "The oldest fetched transaction is within 7 days and the signature query was not truncated.",
    });
  }

  if (portfolio >= 100_000) {
    add({
      id: "whale",
      title: "whale",
      category: "portfolio",
      confidence: "high",
      evidence: `Priced holdings sum to ${money(portfolio)}.`,
    });
  } else if (portfolio >= 10_000) {
    add({
      id: "large_holder",
      title: "large holder",
      category: "portfolio",
      confidence: "high",
      evidence: `Priced holdings sum to ${money(portfolio)}.`,
    });
  }
  if (portfolio > 0 && bluechipUsd / portfolio >= 0.7) {
    add({
      id: "blue_chip_holder",
      title: "blue-chip holder",
      category: "portfolio",
      confidence: "high",
      evidence: `${Math.round((bluechipUsd / portfolio) * 100)}% of priced value is SOL or other blue chips, excluding stablecoins.`,
    });
  }
  if (portfolio > 0 && stableUsd / portfolio >= 0.8) {
    add({
      id: "stablecoin_heavy",
      title: "stablecoin heavy",
      category: "portfolio",
      confidence: "high",
      evidence: `${Math.round((stableUsd / portfolio) * 100)}% of priced value is in stablecoins.`,
    });
  }
  if (portfolio > 0 && lstUsd / portfolio >= 0.5) {
    add({
      id: "liquid_staking",
      title: "liquid staking",
      category: "portfolio",
      confidence: "high",
      evidence: `${Math.round((lstUsd / portfolio) * 100)}% of priced value is jitoSOL, mSOL, or bSOL.`,
    });
  }
  if (pricedHoldings.length >= 5 && top?.usdValue && top.usdValue / portfolio < 0.5) {
    add({
      id: "diversified",
      title: "diversified",
      category: "portfolio",
      confidence: "medium",
      evidence: `${pricedHoldings.length} priced holdings and the largest is under half the book.`,
    });
  }
  if (portfolio > 0 && top?.usdValue && top.usdValue / portfolio >= 0.75) {
    const name = top.symbol ?? "one asset";
    add({
      id: "concentrated_book",
      title: "concentrated book",
      category: "risk",
      confidence: "high",
      evidence: `${name} is ${Math.round((top.usdValue / portfolio) * 100)}% of priced value.`,
    });
  }

  if (!input.pnl.partialCostBasis && input.pnl.closedTrades >= 5 && (input.pnl.winRate ?? 0) >= 0.65) {
    add({
      id: "high_win_rate",
      title: "high win rate",
      category: "performance",
      confidence: "medium",
      evidence: `${input.pnl.winningTrades} of ${input.pnl.closedTrades} priced closes were winners.`,
    });
  }
  if (!input.pnl.partialCostBasis && input.pnl.closedTrades >= 5 && (input.pnl.winRate ?? 1) <= 0.35) {
    add({
      id: "low_win_rate",
      title: "low win rate",
      category: "performance",
      confidence: "medium",
      evidence: `${input.pnl.winningTrades} of ${input.pnl.closedTrades} priced closes were winners.`,
    });
  }
  if (!input.pnl.partialCostBasis && (input.pnl.realizedUsd ?? 0) >= 1 && input.pnl.winningTrades > 0) {
    add({
      id: "net_winner",
      title: "net winner",
      category: "performance",
      confidence: input.pnl.closedTrades >= 3 ? "medium" : "low",
      evidence: `Realized PnL in the window is ${signedMoney(input.pnl.realizedUsd ?? 0)}.`,
    });
  }
  if (!input.pnl.partialCostBasis && (input.pnl.realizedUsd ?? 0) <= -1) {
    add({
      id: "net_loser",
      title: "net loser",
      category: "performance",
      confidence: input.pnl.closedTrades >= 3 ? "medium" : "low",
      evidence: `Realized PnL in the window is ${signedMoney(input.pnl.realizedUsd ?? 0)}.`,
    });
  }

  if (labels.length === 0) {
    add(
      input.swapCount > 0
        ? {
            id: "light_activity",
            title: "light activity",
            category: "activity",
            confidence: "low",
            evidence: `${input.swapCount} swaps in the window, below the turnover and memecoin thresholds.`,
          }
        : {
            id: "holder",
            title: "holder",
            category: "portfolio",
            confidence: "low",
            evidence: "The window shows holdings without enough swap activity to classify behavior.",
          },
    );
  }

  return { labels, details };
}

export function labelWallet(input: LabelInput): string[] {
  return describeWallet(input).labels;
}

function pct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function day(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

export function summarizeWallet(input: {
  portfolioUsd: number | null;
  pricedHoldings: number;
  holdings: HoldingInput[];
  omittedHoldings: number;
  unpricedHoldings: number;
  window: { transactions: number; from: string | null; to: string | null };
  activity: { swapCount: number; uniqueTokensTraded: number; signatureCount: number };
  pnl: PnlEstimate;
  labels: string[];
}): string {
  const sentences: string[] = [];
  if (input.portfolioUsd == null) sentences.push("No priced holdings.");
  else {
    let sentence = `Holds ${money(input.portfolioUsd)} across ${plural(input.pricedHoldings, "priced token")}`;
    if (input.unpricedHoldings > 0) {
      sentence += `, with ${plural(input.unpricedHoldings, "unpriced holding")} excluded from that total`;
    }
    sentences.push(`${sentence}.`);
  }

  const largest = [...input.holdings]
    .filter((holding) => holding.sharePct != null && (holding.usdValue ?? 0) > 0)
    .sort((a, b) => (b.sharePct ?? 0) - (a.sharePct ?? 0))[0];
  if (largest?.sharePct != null) {
    sentences.push(`Largest position is ${largest.symbol ?? "the top holding"} at ${pct(largest.sharePct)}%.`);
  }
  if (input.omittedHoldings > 0) {
    sentences.push(`${plural(input.omittedHoldings, "more holding")} ${input.omittedHoldings === 1 ? "is" : "are"} omitted from the list.`);
  }

  if (input.window.transactions <= 0) sentences.push("No transactions in the fetched window.");
  else {
    const from = day(input.window.from);
    const to = day(input.window.to);
    const span = from && to ? ` from ${from} to ${to}` : "";
    sentences.push(
      `In a ${input.window.transactions}-transaction window${span}, the wallet made ${plural(input.activity.swapCount, "swap")} across ${plural(input.activity.uniqueTokensTraded, "token")}.`,
    );
  }

  if (input.pnl.realizedUsd == null && input.pnl.unrealizedUsd == null) {
    sentences.push("No in-window PnL could be priced.");
  } else {
    const realized = input.pnl.realizedUsd == null ? "unavailable" : signedMoney(input.pnl.realizedUsd);
    const unrealized = input.pnl.unrealizedUsd == null ? "unavailable" : signedMoney(input.pnl.unrealizedUsd);
    let sentence = `Estimated realized PnL is ${realized} and unrealized PnL is ${unrealized}`;
    if (input.pnl.closedTrades > 0 && input.pnl.winRate != null) {
      sentence += ` (win rate ${Math.round(input.pnl.winRate * 100)}% on ${plural(input.pnl.closedTrades, "close")})`;
    }
    if (input.pnl.partialCostBasis) sentence += "; cost basis is partial";
    sentences.push(`${sentence}.`);
  }

  sentences.push(`Labels: ${input.labels.length ? input.labels.join(", ") : "none"}.`);
  return sentences.join(" ");
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

export function rankScore(token: {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  riskFlags: string[];
}): number {
  const volume = token.volume24hUsd ?? 0;
  if (volume <= 0) return 0;
  let score = volume;
  if ((token.liquidityUsd ?? 0) < 15_000) score *= 0.25;
  if (token.riskFlags.includes("wash_suspect")) score *= 0.2;
  if (token.riskFlags.includes("newly_launched")) score *= 0.6;
  return score;
}
