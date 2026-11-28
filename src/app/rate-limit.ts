// Counts attempts per key in a sliding window. It lives in one process, which is enough to slow down scripted
// attempts against a single server; a deployment with several servers needs a shared store instead.
export function createRateLimit({ limit, windowMs, now = Date.now }: { limit: number; windowMs: number; now?: () => number }) {
  const attempts = new Map<string, number[]>();
  const recent = (key: string) => {
    const since = now() - windowMs;
    const times = (attempts.get(key) ?? []).filter(time => time > since);
    if (times.length) attempts.set(key, times);
    else attempts.delete(key);
    return times;
  };
  const limiter = {
    blocked: (key: string) => recent(key).length >= limit,
    record(key: string) {
      attempts.set(key, [...recent(key), now()]);
      if (attempts.size > 10_000) for (const stale of [...attempts.keys()]) recent(stale);
    },
    // Records an attempt when it is within the limit, and says whether it was.
    take(key: string) {
      if (limiter.blocked(key)) return false;
      limiter.record(key);
      return true;
    },
  };
  return limiter;
}
