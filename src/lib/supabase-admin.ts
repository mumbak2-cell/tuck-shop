// Service-role Supabase client for server-side use ONLY.
// Bypasses Row Level Security, so it must never be exposed to the browser.
// Use this exclusively in API route handlers, webhook receivers, and other
// server-only contexts. Reads SUPABASE_SERVICE_ROLE_KEY from env.
//
// Lazy-initialised so that builds without the env var present (e.g. during
// `next build` on a dev machine that has no service role key set) do not
// crash. The error only surfaces at request time, where it should.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  }
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it in Vercel Environment Variables."
    );
  }

  cachedClient = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cachedClient;
}
