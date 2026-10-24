import type { CacheStats } from "./sla.js";

type Entry<T> = { value: T; expires: number; storedAt: number; ttlMs: number; retryAt: number };

export type CacheHit<T> = { value: T; cached: boolean; stale: boolean; ageMs: number };

/** Keep the warm isolate small on the Vercel free tier. */
export const CACHE_MAX_ENTRIES = 400;
/** Serve the last good body for this long after TTL while one refresh runs. */
export const CACHE_STALE_GRACE_MS = 120_000;
const FAILURE_BACKOFF_MS = 15_000;

export function createCache(now: () => number = Date.now) {
  const store = new Map<string, Entry<unknown>>();
  const inflight = new Map<string, Promise<unknown>>();

  function sweep() {
    const current = now();
    for (const [key, entry] of store) {
      if (entry.expires + CACHE_STALE_GRACE_MS <= current) store.delete(key);
    }
  }

  function evict() {
    sweep();
    if (store.size <= CACHE_MAX_ENTRIES) return;
    const ranked = [...store.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
    for (const [key] of ranked) {
      if (store.size <= CACHE_MAX_ENTRIES) break;
      store.delete(key);
    }
  }

  function remember<T>(key: string, value: T, ttlMs: number) {
    const storedAt = now();
    store.set(key, { value, storedAt, expires: storedAt + ttlMs, ttlMs, retryAt: 0 });
    evict();
  }

  function load<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = (async () => {
      try {
        const value = await loader();
        remember(key, value, ttlMs);
        return value;
      } catch (error) {
        const hit = store.get(key);
        if (hit) hit.retryAt = now() + FAILURE_BACKOFF_MS;
        throw error;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  return {
    async getOrSet<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CacheHit<T>> {
      sweep();
      const current = now();
      const hit = store.get(key) as Entry<T> | undefined;
      if (hit && hit.expires > current) {
        return { value: hit.value, cached: true, stale: false, ageMs: Math.max(0, current - hit.storedAt) };
      }
      if (hit && hit.expires + CACHE_STALE_GRACE_MS > current) {
        if (current >= hit.retryAt) void load(key, ttlMs, loader).catch(() => undefined);
        return { value: hit.value, cached: true, stale: true, ageMs: Math.max(0, current - hit.storedAt) };
      }
      try {
        const value = await load(key, ttlMs, loader);
        const stored = store.get(key) as Entry<T> | undefined;
        const ageMs = stored ? Math.max(0, now() - stored.storedAt) : 0;
        return { value, cached: false, stale: false, ageMs };
      } catch (error) {
        const fallback = store.get(key) as Entry<T> | undefined;
        if (fallback) {
          return {
            value: fallback.value,
            cached: true,
            stale: true,
            ageMs: Math.max(0, current - fallback.storedAt),
          };
        }
        throw error;
      }
    },
    stats(): CacheStats {
      sweep();
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
        ttlMs = ttlMs == null ? entry.ttlMs : Math.max(ttlMs, entry.ttlMs);
      }
      return { entries, ageMs, newestAgeMs, ttlMs };
    },
  };
}

export type AppCache = ReturnType<typeof createCache>;
