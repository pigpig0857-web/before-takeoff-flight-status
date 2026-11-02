export interface CacheResult<T> {
  value: T;
  fetchedAt: string;
  stale: boolean;
}
export function createCache<T>(
  ttlMs: number,
  maxStaleMs: number,
  retryMs = 60_000,
) {
  let cached: { value: T; time: number } | null = null;
  let pending: Promise<CacheResult<T>> | null = null;
  let lastFailure: { error: unknown; retryAt: number } | null = null;
  async function load(
    loader: () => Promise<T>,
    now: number,
  ): Promise<CacheResult<T>> {
    try {
      const value = await loader();
      cached = { value, time: now };
      lastFailure = null;
      return { value, fetchedAt: new Date(now).toISOString(), stale: false };
    } catch (error) {
      lastFailure = { error, retryAt: now + retryMs };
      if (cached && now - cached.time <= maxStaleMs)
        return {
          value: cached.value,
          fetchedAt: new Date(cached.time).toISOString(),
          stale: true,
        };
      throw error;
    }
  }
  return {
    async get(
      loader: () => Promise<T>,
      now = Date.now(),
    ): Promise<CacheResult<T>> {
      // Back off after an outage instead of retrying once per user request.
      if (lastFailure && now < lastFailure.retryAt) {
        if (cached && now - cached.time <= maxStaleMs) {
          return {
            value: cached.value,
            fetchedAt: new Date(cached.time).toISOString(),
            stale: true,
          };
        }
        throw lastFailure.error;
      }
      if (cached && now - cached.time < ttlMs)
        return {
          value: cached.value,
          fetchedAt: new Date(cached.time).toISOString(),
          stale: false,
        };
      if (!pending)
        pending = load(loader, now).finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
