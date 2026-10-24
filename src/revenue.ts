import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

/**
 * Process-local ledger of settled x402 payments.
 * Stores the route, USDC amount, network, timestamp, and a sha256 of the
 * payer address. The raw address is never stored or logged. Daily and weekly
 * figures are UTC. Entries older than 90 days are dropped. On a serverless
 * isolate this is that isolate's settlements, not a global treasury total.
 */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 20_000;

const TOOL_ROUTES: Record<string, string> = {
  wallet_profile: "/wallet/profile",
  wallet_funding: "/wallet/funding",
  wallet_quick: "/wallet/quick",
  wallet_quick_batch: "/wallet/quick/batch",
  token_trending: "/token/trending",
};

export type RevenueEvent = {
  route: string;
  amountBaseUnits: string;
  network: string;
  at: string;
  payerHash: string | null;
};

export type RevenueBucket = {
  route: string;
  payments: number;
  amountBaseUnits: string;
  amountUsd: number;
  uniquePayers: number;
};

export type RevenueSummary = {
  asOf: string;
  currency: "USDC";
  decimals: 6;
  retentionDays: number;
  payments: number;
  amountBaseUnits: string;
  amountUsd: number;
  uniquePayers: number;
  daily: Array<RevenueBucket & { day: string }>;
  weekly: Array<RevenueBucket & { week: string }>;
};

const requestPath = new AsyncLocalStorage<string>();
const events: RevenueEvent[] = [];

export function withRevenueRequestPath<T>(path: string, run: () => Promise<T>): Promise<T> {
  return requestPath.run(path, run);
}

export function hashPayer(payer: string | undefined): string | null {
  const trimmed = payer?.trim();
  if (!trimmed) return null;
  const normalized = /^0x/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  return createHash("sha256").update(normalized).digest("hex");
}

export function routeFromResource(resourceUrl: string | undefined, fallbackPath?: string): string {
  const raw = resourceUrl?.trim() ?? "";
  if (raw.startsWith("mcp://tool/")) {
    const tool = decodeURIComponent(raw.slice("mcp://tool/".length).split(/[?#]/)[0] ?? "");
    if (TOOL_ROUTES[tool]) return TOOL_ROUTES[tool];
    return tool ? `/mcp/${tool.slice(0, 80)}` : "/mcp";
  }
  if (raw) {
    try {
      const path = new URL(raw).pathname.replace(/\/+$/, "") || "/";
      return path.slice(0, 128);
    } catch {
      // Resource was not a URL. Fall through to the request path.
    }
  }
  if (fallbackPath?.startsWith("/")) return fallbackPath.split("?")[0]?.slice(0, 128) || "/";
  return "unknown";
}

export function resetRevenueLedger(): void {
  events.length = 0;
}

export function recordRevenue(event: RevenueEvent): void {
  const atMs = Date.parse(event.at);
  if (!Number.isFinite(atMs)) return;
  if (!/^\d+$/.test(event.amountBaseUnits)) return;
  events.push({
    route: event.route.slice(0, 128),
    amountBaseUnits: event.amountBaseUnits,
    network: event.network.slice(0, 80),
    at: new Date(atMs).toISOString(),
    payerHash: event.payerHash,
  });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function usdFromBase(units: bigint): number {
  return Number((Number(units) / 1_000_000).toFixed(6));
}

export function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function revenueSummary(now = new Date()): RevenueSummary {
  const cutoff = now.getTime() - RETENTION_MS;
  const live = events.filter((event) => {
    const at = Date.parse(event.at);
    return Number.isFinite(at) && at >= cutoff && at <= now.getTime() + 60_000;
  });
  const payers = new Set<string>();
  let total = 0n;
  const days = new Map<string, RevenueEvent[]>();
  const weeks = new Map<string, RevenueEvent[]>();
  for (const event of live) {
    const at = new Date(event.at);
    const dayKey = `${at.toISOString().slice(0, 10)} ${event.route}`;
    const weekKey = `${isoWeekKey(at)} ${event.route}`;
    const dayList = days.get(dayKey) ?? [];
    dayList.push(event);
    days.set(dayKey, dayList);
    const weekList = weeks.get(weekKey) ?? [];
    weekList.push(event);
    weeks.set(weekKey, weekList);
    total += BigInt(event.amountBaseUnits);
    if (event.payerHash) payers.add(event.payerHash);
  }

  const bucket = (rows: RevenueEvent[], route: string): RevenueBucket => {
    let units = 0n;
    const unique = new Set<string>();
    for (const row of rows) {
      units += BigInt(row.amountBaseUnits);
      if (row.payerHash) unique.add(row.payerHash);
    }
    return {
      route,
      payments: rows.length,
      amountBaseUnits: units.toString(),
      amountUsd: usdFromBase(units),
      uniquePayers: unique.size,
    };
  };

  const daily = [...days.entries()]
    .map(([key, rows]) => {
      const space = key.indexOf(" ");
      return { day: key.slice(0, space), ...bucket(rows, key.slice(space + 1)) };
    })
    .sort((left, right) => left.day.localeCompare(right.day) || left.route.localeCompare(right.route));
  const weekly = [...weeks.entries()]
    .map(([key, rows]) => {
      const space = key.indexOf(" ");
      return { week: key.slice(0, space), ...bucket(rows, key.slice(space + 1)) };
    })
    .sort((left, right) => left.week.localeCompare(right.week) || left.route.localeCompare(right.route));

  return {
    asOf: now.toISOString(),
    currency: "USDC",
    decimals: 6,
    retentionDays: 90,
    payments: live.length,
    amountBaseUnits: total.toString(),
    amountUsd: usdFromBase(total),
    uniquePayers: payers.size,
    daily,
    weekly,
  };
}

export function noteSettlement(input: {
  success: boolean;
  payer?: string;
  amount?: string;
  requirementsAmount?: string;
  network?: string;
  resourceUrl?: string;
}): void {
  if (!input.success) return;
  try {
    const amountBaseUnits = (input.amount ?? input.requirementsAmount ?? "").trim();
    if (!/^\d+$/.test(amountBaseUnits)) return;
    const route = routeFromResource(input.resourceUrl, requestPath.getStore());
    const payerHash = hashPayer(input.payer);
    const at = new Date().toISOString();
    const network = input.network?.trim() || "unknown";
    recordRevenue({ route, amountBaseUnits, network, at, payerHash });
    console.info(JSON.stringify({ msg: "x402_settled", route, amountBaseUnits, network, at, payerHash }));
  } catch {
    console.error("revenue ledger skipped a settlement");
  }
}

export function observeFacilitator(inner: FacilitatorClient): FacilitatorClient {
  return {
    getSupported: () => inner.getSupported(),
    verify: (payload, requirements) => inner.verify(payload, requirements),
    async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      const result = await inner.settle(payload, requirements);
      noteSettlement({
        success: result.success,
        payer: result.payer,
        amount: result.amount,
        requirementsAmount: requirements.amount,
        network: result.network || requirements.network,
        resourceUrl: payload.resource?.url,
      });
      return result;
    },
  };
}
