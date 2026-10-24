import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createCache } from "../src/cache.js";
import { fetchJson, UpstreamError } from "../src/http.js";
import { createSlaTracker, percentile, runWithSla, SERVICE_VERSION } from "../src/sla.js";
import packageJson from "../package.json" with { type: "json" };

describe("SLA math", () => {
  it("uses nearest-rank percentiles and returns null for an empty window", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([10, 100, 20, 40, 30], 50)).toBe(30);
    expect(percentile([10, 100, 20, 40, 30], 95)).toBe(100);
  });

  it("drops latency samples outside the rolling window", () => {
    let now = 1_000_000;
    const tracker = createSlaTracker({ windowMs: 60_000, now: () => now, version: "9.9.9" });
    tracker.recordLatency(10);
    tracker.recordLatency(20);
    now += 60_001;
    tracker.recordLatency(50);
    const sla = tracker.snapshot({ entries: 0, ageMs: null, newestAgeMs: null, ttlMs: null });
    expect(sla.version).toBe("9.9.9");
    expect(sla.windowMs).toBe(60_000);
    expect(sla.latency).toEqual({ p50Ms: 50, p95Ms: 50, samples: 1 });
  });

  it("marks only upstream RPC rate limits and forgets them after the window", () => {
    let now = 5_000;
    const tracker = createSlaTracker({ windowMs: 60_000, now: () => now, version: SERVICE_VERSION });
    const empty = { entries: 0, ageMs: null, newestAgeMs: null, ttlMs: null };
    expect(tracker.snapshot(empty).upstream).toMatchObject({
      status: "unknown",
      rateLimited: false,
      http429: 0,
      lastLimitedAt: null,
    });

    tracker.noteUpstream({ source: "dexscreener", httpStatus: 429, at: now });
    expect(tracker.snapshot(empty).upstream.status).toBe("unknown");
    expect(tracker.snapshot(empty).upstream.sources).toContainEqual({
      source: "dexscreener",
      status: "rate_limited",
      http429: 1,
    });

    tracker.noteUpstream({ source: "solana-rpc", httpStatus: 200, at: now });
    expect(tracker.snapshot(empty).upstream.status).toBe("ok");

    tracker.noteUpstream({
      source: "solana-rpc",
      httpStatus: 200,
      rateLimited: true,
      at: now + 10,
    });
    const limited = tracker.snapshot(empty).upstream;
    expect(limited.status).toBe("rate_limited");
    expect(limited.rateLimited).toBe(true);
    expect(limited.http429).toBe(0);
    expect(limited.lastLimitedAt).toBe(new Date(now + 10).toISOString());
    expect(JSON.stringify(limited)).not.toContain("supersecret");

    tracker.noteUpstream({ source: "helius", httpStatus: 429, at: now + 20 });
    expect(tracker.snapshot(empty).upstream.http429).toBe(1);

    now = 70_000;
    tracker.noteUpstream({ source: "solana-rpc", httpStatus: 200, at: now });
    expect(tracker.snapshot(empty).upstream.status).toBe("ok");
    expect(tracker.snapshot(empty).upstream.rateLimited).toBe(false);
  });
});

describe("cache age", () => {
  it("reports the oldest live entry and ignores expired ones", async () => {
    let now = 10_000;
    const cache = createCache(() => now);
    await cache.getOrSet("old", 60_000, async () => "old");
    now = 12_500;
    await cache.getOrSet("new", 30_000, async () => "new");
    now = 15_000;
    expect(cache.stats()).toEqual({ entries: 2, ageMs: 5_000, newestAgeMs: 2_500, ttlMs: 60_000 });
    now = 50_000;
    expect(cache.stats()).toEqual({ entries: 1, ageMs: 40_000, newestAgeMs: 40_000, ttlMs: 60_000 });
    now = 70_000;
    expect(cache.stats()).toEqual({ entries: 0, ageMs: null, newestAgeMs: null, ttlMs: null });
  });
});

describe("upstream observation", () => {
  it("records an RPC 429 on the active tracker without keeping the URL", async () => {
    const tracker = createSlaTracker({ version: SERVICE_VERSION });
    const server = createServer((_request, response) => {
      response.writeHead(429, { "content-type": "text/plain" });
      response.end("api-key=supersecret");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      await expect(
        runWithSla(tracker, () =>
          fetchJson(`http://127.0.0.1:${address.port}/rpc?api-key=supersecret`, { source: "solana-rpc" }),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(UpstreamError);
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("HTTP 429");
        expect(message).not.toContain("supersecret");
        return true;
      });
      const upstream = tracker.snapshot({ entries: 0, ageMs: null, newestAgeMs: null, ttlMs: null }).upstream;
      expect(upstream.status).toBe("rate_limited");
      expect(upstream.http429).toBe(1);
      expect(JSON.stringify(upstream)).not.toContain("supersecret");
      expect(JSON.stringify(upstream)).not.toContain("127.0.0.1");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("service version", () => {
  it("matches package.json", () => {
    expect(SERVICE_VERSION).toBe(packageJson.version);
    expect(SERVICE_VERSION).toBe("1.1.0");
  });
});
