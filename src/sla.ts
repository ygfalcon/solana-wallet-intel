import { AsyncLocalStorage } from "node:async_hooks";
import packageJson from "../package.json" with { type: "json" };

export const SERVICE_VERSION = packageJson.version;
export const SLA_WINDOW_MS = 300_000;

const RPC_SOURCES = new Set(["solana-rpc", "helius"]);

export type CacheStats = {
  entries: number;
  ageMs: number | null;
  newestAgeMs: number | null;
  ttlMs: number | null;
};

export type SlaSnapshot = {
  version: string;
  windowMs: number;
  latency: { p50Ms: number | null; p95Ms: number | null; samples: number };
  upstream: {
    status: "unknown" | "ok" | "rate_limited";
    rateLimited: boolean;
    http429: number;
    lastLimitedAt: string | null;
    sources: Array<{ source: string; status: "unknown" | "ok" | "rate_limited"; http429: number }>;
  };
  cache: CacheStats;
};

type LatencySample = { at: number; durationMs: number };
type UpstreamSample = { at: number; source: string; httpStatus: number | null; rateLimited: boolean };

export type SlaTracker = {
  recordLatency: (durationMs: number, at?: number) => void;
  noteUpstream: (event: { source: string; httpStatus: number | null; rateLimited?: boolean; at?: number }) => void;
  snapshot: (cache: CacheStats) => SlaSnapshot;
};

const active = new AsyncLocalStorage<SlaTracker>();

export function runWithSla<T>(tracker: SlaTracker, fn: () => T): T {
  return active.run(tracker, fn);
}

export function currentSla(): SlaTracker | undefined {
  return active.getStore();
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

export function createSlaTracker(options: { windowMs?: number; now?: () => number; version?: string } = {}): SlaTracker {
  const windowMs = options.windowMs ?? SLA_WINDOW_MS;
  const now = options.now ?? Date.now;
  const version = options.version ?? SERVICE_VERSION;
  const latencies: LatencySample[] = [];
  const upstreams: UpstreamSample[] = [];

  function trim(at: number) {
    const cutoff = at - windowMs;
    while (latencies.length > 0 && latencies[0].at < cutoff) latencies.shift();
    while (upstreams.length > 0 && upstreams[0].at < cutoff) upstreams.shift();
  }

  return {
    recordLatency(durationMs, at = now()) {
      latencies.push({ at, durationMs });
      trim(now());
      if (latencies.length > 2_000) latencies.splice(0, latencies.length - 2_000);
    },
    noteUpstream(event) {
      const at = event.at ?? now();
      upstreams.push({
        at,
        source: event.source,
        httpStatus: event.httpStatus,
        rateLimited: event.rateLimited ?? event.httpStatus === 429,
      });
      upstreams.sort((a, b) => a.at - b.at);
      trim(now());
      if (upstreams.length > 2_000) upstreams.splice(0, upstreams.length - 2_000);
    },
    snapshot(cache) {
      const at = now();
      trim(at);
      const durations = latencies.map((sample) => sample.durationMs);
      const bySource = new Map<string, { http429: number; rateLimited: boolean; ok: boolean; lastLimitedAt: number | null }>();
      for (const sample of upstreams) {
        const row = bySource.get(sample.source) ?? { http429: 0, rateLimited: false, ok: false, lastLimitedAt: null };
        if (sample.httpStatus === 429) row.http429 += 1;
        if (sample.rateLimited) {
          row.rateLimited = true;
          row.lastLimitedAt = row.lastLimitedAt == null ? sample.at : Math.max(row.lastLimitedAt, sample.at);
        }
        if (sample.httpStatus != null && sample.httpStatus >= 200 && sample.httpStatus < 300 && !sample.rateLimited) {
          row.ok = true;
        }
        bySource.set(sample.source, row);
      }
      const sources = [...bySource.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([source, row]) => ({
          source,
          status: (row.rateLimited ? "rate_limited" : row.ok ? "ok" : "unknown") as "unknown" | "ok" | "rate_limited",
          http429: row.http429,
        }));
      const rpc = [...bySource.entries()].filter(([source]) => RPC_SOURCES.has(source));
      const rateLimited = rpc.some(([, row]) => row.rateLimited);
      const ok = rpc.some(([, row]) => row.ok);
      const lastLimited = rpc.reduce<number | null>((latest, [, row]) => {
        if (row.lastLimitedAt == null) return latest;
        return latest == null ? row.lastLimitedAt : Math.max(latest, row.lastLimitedAt);
      }, null);
      return {
        version,
        windowMs,
        latency: {
          p50Ms: percentile(durations, 50),
          p95Ms: percentile(durations, 95),
          samples: durations.length,
        },
        upstream: {
          status: rateLimited ? "rate_limited" : ok ? "ok" : "unknown",
          rateLimited,
          http429: rpc.reduce((sum, [, row]) => sum + row.http429, 0),
          lastLimitedAt: lastLimited == null ? null : new Date(lastLimited).toISOString(),
          sources,
        },
        cache,
      };
    },
  };
}

export function rpcBodyRateLimited(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("error" in body)) return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object" || !("message" in error)) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /rate limit|too many requests|\b429\b/i.test(message);
}
