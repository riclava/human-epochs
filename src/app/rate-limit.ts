// Counts attempts per key in a sliding window. It lives in one process, which is enough to slow down scripted
// sign-ups against a single server; a deployment with several servers needs a shared store instead.
export function createRateLimit({ limit, windowMs, now = Date.now }: { limit: number; windowMs: number; now?: () => number }) {
  const attempts = new Map<string, number[]>();
  return {
    // Records an attempt and says whether it is within the limit.
    take(key: string) {
      const since = now() - windowMs;
      const recent = (attempts.get(key) ?? []).filter(time => time > since);
      if (recent.length >= limit) {
        attempts.set(key, recent);
        return false;
      }
      recent.push(now());
      attempts.set(key, recent);
      if (attempts.size > 10_000) for (const [stale, times] of attempts) if (times.every(time => time <= since)) attempts.delete(stale);
      return true;
    },
  };
}
