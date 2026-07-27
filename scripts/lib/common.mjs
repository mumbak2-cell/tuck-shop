import { createClient } from "@supabase/supabase-js";

export const PAGE = 1000;

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function fetchAll(build, pageSize = PAGE) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

export async function resolveOrg(supabase, name, select = "id, name") {
  const { data: orgs, error } = await supabase
    .from("organizations")
    .select(select)
    .ilike("name", `%${name}%`);
  if (error) throw new Error(error.message);
  if (!orgs?.length) throw new Error(`No shop matching "${name}"`);
  if (orgs.length > 1)
    throw new Error(`"${name}" matches: ${orgs.map((o) => o.name).join(", ")}`);
  return orgs[0];
}

export async function resolveBranch(supabase, orgId, branchName) {
  const { data: locs, error } = await supabase
    .from("locations")
    .select("id, name, active")
    .eq("org_id", orgId);
  if (error) throw new Error(error.message);
  const branch = (locs || []).find(
    (l) => l.name.trim().toLowerCase() === branchName.trim().toLowerCase()
  );
  if (!branch) {
    throw new Error(
      `No branch "${branchName}". Have: ${(locs || []).map((l) => l.name).join(", ")}`
    );
  }
  return branch;
}

export function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
}

export function runMain(fn) {
  fn().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
