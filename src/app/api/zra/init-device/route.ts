// POST /api/zra/init-device
// One-time VSDC device initialisation. Calls selectInitInfo and stores the
// security key in zra_config. Only needs to be called once per org.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { initDevice, VsdcError } from "@/lib/zra-vsdc";

export const runtime = "nodejs";

export async function POST(req: Request) {
  // --- Auth: resolve calling user → org ---
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const supabaseUser = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  const { data: userData, error: userErr } = await supabaseUser.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = getSupabaseAdmin();

  // Get user's org
  const { data: membership } = await admin
    .from("org_members")
    .select("org_id")
    .eq("user_id", userData.user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ error: "No organization found" }, { status: 404 });
  }

  // Get ZRA config
  const { data: config } = await admin
    .from("zra_config")
    .select("*")
    .eq("org_id", membership.org_id)
    .maybeSingle();

  if (!config) {
    return NextResponse.json(
      { error: "ZRA is not configured for this organization. Add VSDC details first." },
      { status: 404 },
    );
  }

  if (config.initialized) {
    return NextResponse.json(
      { error: "Device is already initialized", initialized: true },
      { status: 409 },
    );
  }

  // --- Call VSDC ---
  try {
    const result = await initDevice({
      vsdc_url: config.vsdc_url,
      tpin: config.tpin,
      bhf_id: config.bhf_id,
      device_serial: config.device_serial,
    });

    // Mark as initialized
    await admin
      .from("zra_config")
      .update({ initialized: true, updated_at: new Date().toISOString() })
      .eq("id", config.id);

    return NextResponse.json({
      ok: true,
      taxpayer: result.data?.info ?? null,
    });
  } catch (err) {
    if (err instanceof VsdcError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "Unexpected error during device initialisation" },
      { status: 500 },
    );
  }
}
