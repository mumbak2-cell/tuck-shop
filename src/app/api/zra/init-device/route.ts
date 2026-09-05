// POST /api/zra/init-device
// One-time VSDC device initialisation. Calls selectInitInfo and stores the
// security key in zra_config. Only needs to be called once per org.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireOrgOwner } from "@/lib/org-owner";
import { initDevice, VsdcError } from "@/lib/zra-vsdc";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireOrgOwner(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const admin = getSupabaseAdmin();

  const rl = await rateLimit(`zra-init:${auth.orgId}`, { max: 3 });
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  // Get ZRA config
  const { data: config } = await admin
    .from("zra_config")
    .select("*")
    .eq("org_id", auth.orgId!)
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
