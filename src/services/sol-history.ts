import { fetchJson } from "../http.js";

export type Candle = [number, number, number, number, number, number];

const HOUR = 3600;
const DAY = 86_400;
const MAX_CANDLES = 300;

export function chooseGranularity(fromSec: number, toSec: number): number {
  const span = Math.max(0, toSec - fromSec);
  return span <= 240 * HOUR ? HOUR : DAY;
}

export function bucketStart(unixSeconds: number, granularity: number): number {
  if (!Number.isFinite(unixSeconds) || granularity <= 0) return 0;
  return Math.floor(unixSeconds / granularity) * granularity;
}

export function indexClosePrices(candles: Candle[], granularity: number): Map<number, number> {
  const index = new Map<number, number>();
  for (const candle of candles) {
    const [time, , , , close] = candle;
    if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) continue;
    index.set(bucketStart(time, granularity), close);
  }
  return index;
}

export function closeAt(index: Map<number, number>, unixSeconds: number, granularity: number): number | null {
  const price = index.get(bucketStart(unixSeconds, granularity));
  return price != null && price > 0 ? price : null;
}

async function fetchCandles(fromSec: number, toSec: number, granularity: number): Promise<Candle[]> {
  const url = `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=${granularity}&start=${Math.floor(fromSec)}&end=${Math.floor(toSec)}`;
  const body = await fetchJson<Candle[]>(url, { source: "coinbase", timeoutMs: 8_000 });
  return Array.isArray(body) ? body : [];
}

export async function loadSolUsdSeries(timestamps: number[]): Promise<{
  prices: Map<number, number>;
  granularity: number;
  ok: boolean;
}> {
  const times = timestamps.filter((time) => Number.isFinite(time) && time > 0);
  if (times.length === 0) return { prices: new Map(), granularity: HOUR, ok: true };
  const from = Math.min(...times);
  const to = Math.max(...times) + 1;
  const granularity = chooseGranularity(from, to);
  const candles: Candle[] = [];
  try {
    const step = granularity * MAX_CANDLES;
    for (let start = bucketStart(from, granularity); start < to; start += step) {
      const end = Math.min(to + granularity, start + step);
      candles.push(...(await fetchCandles(start, end, granularity)));
    }
    return { prices: indexClosePrices(candles, granularity), granularity, ok: true };
  } catch {
    return { prices: new Map(), granularity, ok: false };
  }
}
