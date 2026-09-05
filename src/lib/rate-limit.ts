// Sliding-window rate limiter backed by Upstash Redis (security-audit
// finding: the previous in-memory Map reset on every serverless cold start,
// which on Vercel is frequent enough to make the limit largely decorative).
// State now lives in Redis, shared across every instance/cold start.

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// Vercel's Upstash marketplace integration provisions KV_REST_API_URL/TOKEN
// (the legacy @vercel/kv variable names, kept for compatibility) — not the
// UPSTASH_REDIS_REST_URL/TOKEN names @upstash/redis's Redis.fromEnv() looks
// for by default, hence constructing the client explicitly here.
const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// One Ratelimit instance per distinct (windowMs, max) pair — every current
// caller uses the default window, so in practice this cache holds a single
// entry, but it stays correct if a future caller passes a custom one.
const limiters = new Map<string, Ratelimit>();

function getLimiter(windowMs: number, max: number): Ratelimit {
  const cacheKey = windowMs + ":" + max;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, `${Math.round(windowMs / 1000)} s`),
      analytics: false,
      prefix: "tilify-rl",
    });
    limiters.set(cacheKey, limiter);
  }
  return limiter;
}

export async function rateLimit(
  key: string,
  { windowMs = 60_000, max = 10 }: { windowMs?: number; max?: number } = {}
): Promise<{ ok: boolean; remaining: number }> {
  const { success, remaining } = await getLimiter(windowMs, max).limit(key);
  return { ok: success, remaining };
}
