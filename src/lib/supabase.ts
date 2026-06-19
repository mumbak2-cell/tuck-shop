import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Browser client with auth persistence enabled. The session is stored in
// localStorage under the key "tilify-auth" and auto-refreshed in the
// background. Every request carries the auth JWT so RLS policies can
// scope queries by the user's organization.
const clientOpts = {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "tilify-auth",
    flowType: "pkce" as const,
  },
};

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, clientOpts);

// Untyped client for tables added in Phase 5+ that aren't in the generated types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = createClient(supabaseUrl, supabaseAnonKey, clientOpts) as any;
