// In-memory sliding-window rate limiter. Runs on Vercel serverless, so this
// state resets per cold start — acceptable for basic abuse prevention, not a
// hard guarantee. For real protection, use Vercel edge middleware or Redis.

const hits = new Map<string, number[]>();

export function rateLimit(
  key: string,
  { windowMs = 60_000, max = 10 }: { windowMs?: number; max?: number } = {}
): { ok: boolean; remaining: number } {
  const now = Date.now();
  const timestamps = (hits.get(key) ?? []).filter((t) => t > now - windowMs);

  if (timestamps.length >= max) {
    hits.set(key, timestamps);
    return { ok: false, remaining: 0 };
  }

  timestamps.push(now);
  hits.set(key, timestamps);
  return { ok: true, remaining: max - timestamps.length };
}
