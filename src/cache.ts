type Entry<T> = { value: T; expires: number };

export type CacheHit<T> = { value: T; cached: boolean; stale: boolean };

export function createCache() {
  const store = new Map<string, Entry<unknown>>();

  return {
    async getOrSet<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CacheHit<T>> {
      const now = Date.now();
      const hit = store.get(key) as Entry<T> | undefined;
      if (hit && hit.expires > now) {
        return { value: hit.value, cached: true, stale: false };
      }
      try {
        const value = await loader();
        store.set(key, { value, expires: now + ttlMs });
        return { value, cached: false, stale: false };
      } catch (error) {
        if (hit) return { value: hit.value, cached: true, stale: true };
        throw error;
      }
    },
  };
}

export type AppCache = ReturnType<typeof createCache>;
