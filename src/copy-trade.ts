import { QUOTE_MINTS } from "./config.js";
import { isStableMint, netLegs, type TradeEvent, type TradeLeg } from "./analytics.js";

/**
 * Copy-trade score from swaps the profile already loaded.
 *
 * A copier is filled 3 seconds after the wallet and pays a 3.6% round trip
 * (pump.fun-class costs). The next same-mint print inside 30 seconds is the
 * only price used for that delay, scaled by 3/elapsed, so this adds no RPC.
 * Win rate is the share of those delayed closes that stay positive. The blend
 * shrinks toward 0.5 with k=8. Bot flow and insider or sniper flow are then
 * penalized because that edge is not something a 3-second copier can keep.
 */
export const COPY_DELAY_SECONDS = 3;
export const COPY_DELAY_WINDOW_SECONDS = 30;
export const COPY_ROUND_TRIP_COST = 0.036;
export const COPY_SHRINKAGE_K = 8;
export const COPY_PRIOR = 0.5;
export const COPY_BOT_PENALTY = 0.25;
export const COPY_INSIDER_PENALTY = 0.2;
export const COPY_RETURN_SPAN = 0.4;

export const COPY_TRADE_METHOD =
  "FIFO closes of quote-priced token swaps held at least 3s. A copier's entry and exit each move by 3/elapsed of the next same-mint print inside 30s. A 3.6% round trip is then subtracted. The score is 70% of a scale where -20% to +20% copy-return maps to 0 to 1, plus 30% copy win rate, shrunk toward 0.5 with k=8, then minus 0.25 for bot flow and 0.20 for insider flow. Null when nothing was copyable. No extra RPC.";

export type CopyTradeGrade = "A" | "B" | "C" | "D" | "F";
export type CopyTradePenalty = "bot" | "insider";

export type CopyTradeAssessment = {
  score: number | null;
  grade: CopyTradeGrade | null;
  copyReturn: number | null;
  winRate: number | null;
  sampleSize: number;
  penalties: CopyTradePenalty[];
  delaySeconds: number;
  delayWindowSeconds: number;
  roundTripCost: number;
  shrinkageK: number;
  prior: number;
  method: string;
};

export type CopyTradeInput = {
  trades: Array<TradeLeg[] | TradeEvent>;
  prices: Map<string, number>;
  labels?: string[];
  medianSwapGapSeconds?: number | null;
  swapCount?: number;
  historyTruncated?: boolean;
  firstActiveAt?: string | null;
  nowMs?: number;
};

type Print = { mint: string; at: number; qty: number; price: number; side: "buy" | "sell" };
type Lot = { qty: number; price: number; at: number };
type Close = { copyReturn: number; costUsd: number; grossReturn: number };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function emptyCopyTrade(penalties: CopyTradePenalty[] = []): CopyTradeAssessment {
  return {
    score: null,
    grade: null,
    copyReturn: null,
    winRate: null,
    sampleSize: 0,
    penalties,
    delaySeconds: COPY_DELAY_SECONDS,
    delayWindowSeconds: COPY_DELAY_WINDOW_SECONDS,
    roundTripCost: COPY_ROUND_TRIP_COST,
    shrinkageK: COPY_SHRINKAGE_K,
    prior: COPY_PRIOR,
    method: COPY_TRADE_METHOD,
  };
}

export function gradeCopyTrade(score: number): CopyTradeGrade {
  if (score >= 0.8) return "A";
  if (score >= 0.65) return "B";
  if (score >= 0.5) return "C";
  if (score >= 0.35) return "D";
  return "F";
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function eventsOf(trades: Array<TradeLeg[] | TradeEvent>): Array<TradeEvent & { index: number }> {
  return trades.map((trade, index) => {
    if (Array.isArray(trade)) return { at: null, legs: trade, index };
    return { at: trade.at ?? null, legs: trade.legs ?? [], index };
  });
}

function quoteNotionalUsd(legs: TradeLeg[], prices: Map<string, number>): number {
  let usd = 0;
  for (const leg of legs) {
    if (!QUOTE_MINTS.has(leg.mint)) continue;
    const quoted = positive(leg.usdPrice) ?? positive(prices.get(leg.mint));
    const price = isStableMint(leg.mint) ? (quoted ?? 1) : quoted;
    if (price == null) continue;
    usd += Math.abs(leg.delta) * price;
  }
  return usd;
}

function readSwap(trade: TradeEvent & { index?: number }, prices: Map<string, number>): Print | null {
  if (trade.at == null || !Number.isFinite(trade.at)) return null;
  const legs = netLegs(trade.legs);
  const tokens = legs.filter((leg) => !QUOTE_MINTS.has(leg.mint) && Math.abs(leg.delta) > 1e-12);
  if (tokens.length !== 1) return null;
  const token = tokens[0];
  if (!token) return null;
  const notional = quoteNotionalUsd(legs, prices);
  if (notional <= 0.0001) return null;
  const price = notional / Math.abs(token.delta);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    mint: token.mint,
    at: trade.at,
    qty: Math.abs(token.delta),
    price,
    side: token.delta > 0 ? "buy" : "sell",
  };
}

function priceAfterDelay(tape: Print[], mint: string, at: number, price: number): number {
  const next = tape.find(
    (print) =>
      print.mint === mint &&
      print.at >= at + COPY_DELAY_SECONDS &&
      print.at <= at + COPY_DELAY_WINDOW_SECONDS,
  );
  if (!next) return price;
  const elapsed = Math.max(COPY_DELAY_SECONDS, next.at - at);
  const relative = (next.price - price) / price;
  const adjusted = price * (1 + relative * (COPY_DELAY_SECONDS / elapsed));
  return adjusted > 0 && Number.isFinite(adjusted) ? adjusted : price;
}

function isFreshWallet(firstActiveAt: string | null | undefined, historyTruncated: boolean | undefined, nowMs: number): boolean {
  if (historyTruncated !== false || !firstActiveAt) return false;
  const started = Date.parse(firstActiveAt);
  if (!Number.isFinite(started)) return false;
  const age = nowMs - started;
  return age >= 0 && age <= WEEK_MS;
}

export function scoreCopyTrade(input: CopyTradeInput): CopyTradeAssessment {
  const ordered = eventsOf(input.trades).sort((left, right) => {
    if (left.at != null && right.at != null && left.at !== right.at) return left.at - right.at;
    if (left.at != null && right.at == null) return -1;
    if (left.at == null && right.at != null) return 1;
    return (left.index ?? 0) - (right.index ?? 0);
  });
  const tape = ordered.flatMap((trade) => {
    const print = readSwap(trade, input.prices);
    return print ? [print] : [];
  });

  const lots = new Map<string, Lot[]>();
  const closes: Close[] = [];
  let insider = false;

  for (const print of tape) {
    if (print.side === "buy") {
      const queue = lots.get(print.mint) ?? [];
      queue.push({ qty: print.qty, price: print.price, at: print.at });
      lots.set(print.mint, queue);
      continue;
    }
    let remaining = print.qty;
    const queue = lots.get(print.mint) ?? [];
    while (remaining > 1e-12 && queue.length > 0) {
      const lot = queue[0];
      if (!lot) break;
      const take = Math.min(remaining, lot.qty);
      const hold = print.at - lot.at;
      const grossReturn = lot.price > 0 ? print.price / lot.price - 1 : 0;
      if (hold < COPY_DELAY_SECONDS) {
        if (grossReturn > 0 && take * lot.price >= 0.01) insider = true;
      } else if (take * lot.price >= 0.01) {
        const entry = priceAfterDelay(tape, print.mint, lot.at, lot.price);
        const exit = priceAfterDelay(tape, print.mint, print.at, print.price);
        if (entry > 0 && exit > 0) {
          closes.push({
            copyReturn: roundTo(exit / entry - 1 - COPY_ROUND_TRIP_COST, 4),
            costUsd: take * entry,
            grossReturn,
          });
        }
      }
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-12) queue.shift();
    }
  }

  const bot =
    (input.labels ?? []).some((label) => /bot/i.test(label)) ||
    (input.medianSwapGapSeconds != null &&
      input.medianSwapGapSeconds <= COPY_DELAY_SECONDS &&
      (input.swapCount ?? 0) >= 4);
  const freshOneShot =
    isFreshWallet(input.firstActiveAt, input.historyTruncated, input.nowMs ?? Date.now()) &&
    closes.length === 1 &&
    (closes[0]?.grossReturn ?? 0) >= 1;
  if (freshOneShot) insider = true;

  const penalties: CopyTradePenalty[] = [];
  if (bot) penalties.push("bot");
  if (insider) penalties.push("insider");
  if (closes.length === 0) return emptyCopyTrade(penalties);

  const cost = closes.reduce((sum, close) => sum + close.costUsd, 0);
  const mean =
    cost > 0
      ? closes.reduce((sum, close) => sum + close.copyReturn * close.costUsd, 0) / cost
      : closes.reduce((sum, close) => sum + close.copyReturn, 0) / closes.length;
  const copyReturn = roundTo(mean, 4);
  const wins = closes.filter((close) => close.copyReturn > 0).length;
  const winRate = roundTo(wins / closes.length, 3);
  const returnScore = clamp01(0.5 + copyReturn / COPY_RETURN_SPAN);
  const raw = 0.7 * returnScore + 0.3 * winRate;
  const shrunk = (closes.length * raw + COPY_SHRINKAGE_K * COPY_PRIOR) / (closes.length + COPY_SHRINKAGE_K);
  const penalty = (bot ? COPY_BOT_PENALTY : 0) + (insider ? COPY_INSIDER_PENALTY : 0);
  const score = roundTo(clamp01(shrunk - penalty), 3);

  return {
    ...emptyCopyTrade(penalties),
    score,
    grade: gradeCopyTrade(score),
    copyReturn,
    winRate,
    sampleSize: closes.length,
  };
}
