import { describe, expect, it } from "vitest";
import { CACHE_MAX_ENTRIES, CACHE_STALE_GRACE_MS, createCache } from "../src/cache.js";

describe("response cache", () => {
  it("coalesces concurrent misses onto one loader", async () => {
    const cache = createCache(() => 1_000);
    let release: (value: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const first = cache.getOrSet("k", 1_000, async () => {
      calls += 1;
      return gate;
    });
    const second = cache.getOrSet("k", 1_000, async () => {
      calls += 1;
      return "other";
    });
    release("fresh");
    await expect(first).resolves.toMatchObject({ value: "fresh", cached: false, stale: false, ageMs: 0 });
    await expect(second).resolves.toMatchObject({ value: "fresh", cached: false });
    expect(calls).toBe(1);
  });

  it("serves a stale body while one refresh runs and backs off after a failed refresh", async () => {
    let now = 1_000;
    const cache = createCache(() => now);
    await cache.getOrSet("k", 1_000, async () => "fresh");
    now = 2_000;
    let refreshed = 0;
    const stale = await cache.getOrSet("k", 1_000, async () => {
      refreshed += 1;
      return "next";
    });
    expect(stale).toMatchObject({ value: "fresh", cached: true, stale: true, ageMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    now = 2_010;
    const again = await cache.getOrSet("k", 1_000, async () => "nope");
    expect(again).toMatchObject({ value: "next", cached: true, stale: false });
    expect(refreshed).toBe(1);

    now = 2_010 + 1_000;
    const failed = await cache.getOrSet("k", 1_000, async () => {
      throw new Error("down");
    });
    expect(failed).toMatchObject({ value: "next", stale: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    let retried = 0;
    now += 1_000;
    const held = await cache.getOrSet("k", 1_000, async () => {
      retried += 1;
      return "later";
    });
    expect(held.value).toBe("next");
    expect(retried).toBe(0);
  });

  it("drops entries past the stale grace and caps the warm set", async () => {
    let now = 5_000;
    const cache = createCache(() => now);
    await cache.getOrSet("old", 1_000, async () => "old");
    now = 5_000 + 1_000 + CACHE_STALE_GRACE_MS;
    await expect(cache.getOrSet("old", 1_000, async () => {
      throw new Error("gone");
    })).rejects.toThrow("gone");

    now = 9_000;
    const capped = createCache(() => now);
    for (let index = 0; index < CACHE_MAX_ENTRIES + 1; index += 1) {
      await capped.getOrSet(String(index), 60_000, async () => index);
    }
    expect(capped.stats().entries).toBe(CACHE_MAX_ENTRIES);
    const reloaded = await capped.getOrSet("0", 60_000, async () => "reloaded");
    expect(reloaded).toMatchObject({ value: "reloaded", cached: false });
  });
});
