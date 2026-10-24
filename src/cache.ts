import type { CacheStats } from "./sla.js";

type Entry<T> = { value: T; expires: number; storedAt: number };

export type CacheHit<T> = { value: T; cached: boolean; stale: boolean };

export function createCache(now: () => number = Date.now) {
  const store = new Map<string, Entry<unknown>>();

  return {
    async getOrSet<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CacheHit<T>> {
      const current = now();
      const hit = store.get(key) as Entry<T> | undefined;
      if (hit && hit.expires > current) {
        return { value: hit.value, cached: true, stale: false };
      }
      try {
        const value = await loader();
        const storedAt = now();
        store.set(key, { value, storedAt, expires: storedAt + ttlMs });
        return { value, cached: false, stale: false };
      } catch (error) {
        if (hit) return { value: hit.value, cached: true, stale: true };
        throw error;
      }
    },
    stats(): CacheStats {
      const current = now();
      let entries = 0;
      let ageMs: number | null = null;
      let newestAgeMs: number | null = null;
      let ttlMs: number | null = null;
      for (const entry of store.values()) {
        if (entry.expires <= current) continue;
        entries += 1;
        const age = Math.max(0, current - entry.storedAt);
        ageMs = ageMs == null ? age : Math.max(ageMs, age);
        newestAgeMs = newestAgeMs == null ? age : Math.min(newestAgeMs, age);
        const ttl = entry.expires - entry.storedAt;
        ttlMs = ttlMs == null ? ttl : Math.max(ttlMs, ttl);
      }
      return { entries, ageMs, newestAgeMs, ttlMs };
    },
  };
}

export type AppCache = ReturnType<typeof createCache>;
