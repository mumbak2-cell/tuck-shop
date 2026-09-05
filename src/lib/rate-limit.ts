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

export async function rateLimit(
  key: string,
  { windowMs = 60_000, max = 10 }: { windowMs?: number; max?: number } = {}
): Promise<{ ok: boolean; remaining: number }> {
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(max, `${Math.round(windowMs / 1000)} s`),
    analytics: false,
    prefix: "tilify-rl",
  });
  try {
    const { success, remaining } = await limiter.limit(key);
    return { ok: success, remaining };
  } catch (err) {
    // Fail open: this is basic abuse prevention, not a hard guarantee (see
    // header comment). A Redis outage/misconfiguration blocking real
    // operations — ZRA fiscal submission, team invites, billing — would be
    // a worse outcome than occasionally letting extra requests through
    // during a rare infra blip.
    console.error("rateLimit: Upstash call failed, failing open", err);
    return { ok: true, remaining: max };
  }
}
