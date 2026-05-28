import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);

// Untyped client for tables added in Phase 5 that aren't in the generated types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = createClient(supabaseUrl, supabaseAnonKey) as any;
