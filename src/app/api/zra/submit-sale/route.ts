// POST /api/zra/submit-sale
// Submits a completed sale to ZRA via the shop's local VSDC.
// Called from the POS after a successful sale, returns the ZRA receipt number.
//
// Body: {
//   saleId:       string,    // Tilify sale UUID
//   items:        SaleItem[],
//   total:        number,    // VAT-inclusive total
//   paymentMethod: string,
//   customerName?: string,
//   customerTpin?: string,
//   saleDate:     string,    // ISO 8601
//   receiptNo:    string,    // Tilify receipt number (used as internal ref)
//   cashierName?: string,
// }

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  saveSales,
  toVsdcPaymentType,
  toVsdcDateTime,
  vatBreakdown,
  VsdcError,
  type VsdcSaleItem,
  type VsdcSaveSalesRequest,
  type VsdcCredentials,
} from "@/lib/zra-vsdc";
import { z } from "zod";

export const runtime = "nodejs";

const SaleItemSchema = z.object({
  productId: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  itemClsCd: z.string().optional(),
});

const SubmitSaleSchema = z.object({
  saleId: z.string().uuid(),
  items: z.array(SaleItemSchema).min(1),
  total: z.number().positive(),
  paymentMethod: z.string().min(1),
  customerName: z.string().nullish(),
  customerTpin: z.string().nullish(),
  saleDate: z.string().min(1),
  receiptNo: z.string().min(1),
  cashierName: z.string().optional(),
});

export async function POST(req: Request) {
  // --- Auth ---
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

  // --- Parse & validate body ---
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = SubmitSaleSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const admin = getSupabaseAdmin();

  // --- Get org + ZRA config ---
  const { data: membership } = await admin
    .from("org_members")
    .select("org_id")
    .eq("user_id", userData.user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ error: "No organization found" }, { status: 404 });
  }
  const orgId = membership.org_id;

  const { data: config } = await admin
    .from("zra_config")
    .select("*")
    .eq("org_id", orgId)
    .eq("enabled", true)
    .maybeSingle();

  if (!config) {
    // ZRA not enabled — that's fine, just return without a ZRA receipt
    return NextResponse.json({ ok: true, zraEnabled: false, rcptNo: null });
  }

  if (!config.initialized) {
    return NextResponse.json(
      { error: "VSDC device not initialized. Run /api/zra/init-device first." },
      { status: 412 },
    );
  }

  // --- Build VSDC payload ---
  const creds: VsdcCredentials = {
    vsdc_url: config.vsdc_url,
    tpin: config.tpin,
    bhf_id: config.bhf_id,
    device_serial: config.device_serial,
  };

  const saleDate = new Date(body.saleDate);
  const taxCd = (config.default_tax_cd as "A" | "B" | "F") || "B";
  const taxRate = Number(config.default_tax_rate) || 16;

  // Build item list — sum already-rounded per-item values to avoid float drift
  const itemList: VsdcSaleItem[] = body.items.map((item, idx) => {
    const splyAmt = item.quantity * item.unitPrice;
    const { taxableAmt, taxAmt } = vatBreakdown(splyAmt, taxRate);

    return {
      itemSeq: idx + 1,
      itemClsCd: item.itemClsCd || "5020230100",
      itemCd: item.productId,
      itemNm: item.name.substring(0, 200),
      pkgUnitCd: "NT",
      qtyUnitCd: "U",
      qty: item.quantity,
      prc: item.unitPrice,
      splyAmt,
      dcAmt: 0,
      dcRt: 0,
      taxblAmt: taxableAmt,
      taxTyCd: taxCd,
      taxAmt,
      totAmt: splyAmt,
    };
  });

  // Sum from the already-rounded item values to prevent header vs item mismatch
  const totalTaxableAmt = Math.round(itemList.reduce((s, i) => s + i.taxblAmt, 0) * 100) / 100;
  const totalTaxAmt = Math.round(itemList.reduce((s, i) => s + i.taxAmt, 0) * 100) / 100;

  // Build the tax amount fields dynamically based on tax code
  const taxFields: Record<string, number> = {};
  taxFields[`taxblAmt${taxCd}`] = totalTaxableAmt;
  taxFields[`taxRt${taxCd}`] = taxRate;
  taxFields[`taxAmt${taxCd}`] = totalTaxAmt;

  const salesPayload: VsdcSaveSalesRequest = {
    tpin: config.tpin,
    bhfId: config.bhf_id,
    orgInvcNo: null,
    rcptTyCd: "S",
    pmtTyCd: toVsdcPaymentType(body.paymentMethod),
    salesTyCd: "N",
    salesSttsCd: "02",
    custTpin: body.customerTpin || null,
    custNm: body.customerName || null,
    salesDt: toVsdcDateTime(saleDate),
    regrNm: body.cashierName || "Tilify",
    modrNm: body.cashierName || "Tilify",
    rcptNo: 0, // VSDC assigns this
    itemList,
    ...taxFields,
    totTaxblAmt: totalTaxableAmt,
    totTaxAmt: totalTaxAmt,
    totAmt: body.total,
    totItemCnt: body.items.length,
  };

  // --- Create invoice log (pending) ---
  const { data: invoice } = await admin
    .from("zra_invoices")
    .insert({
      org_id: orgId,
      sale_id: body.saleId,
      status: "pending",
      request_payload: salesPayload,
      attempts: 1,
    })
    .select("id")
    .single();

  // --- Call VSDC ---
  try {
    const result = await saveSales(creds, salesPayload);
    const zraData = result.data;

    // Update invoice log with success
    if (invoice) {
      await admin
        .from("zra_invoices")
        .update({
          status: "submitted",
          rcpt_no: zraData?.rcptNo ? String(zraData.rcptNo) : null,
          intrl_data: zraData?.intrlData ?? null,
          rcpt_sign: zraData?.rcptSign ?? null,
          vsdc_rcpt_pbct_date: zraData?.vsdcRcptPbctDate ?? null,
          response_payload: result,
          submitted_at: new Date().toISOString(),
        })
        .eq("id", invoice.id);
    }

    return NextResponse.json({
      ok: true,
      zraEnabled: true,
      rcptNo: zraData?.rcptNo ? String(zraData.rcptNo) : null,
      intrlData: zraData?.intrlData ?? null,
      rcptSign: zraData?.rcptSign ?? null,
    });
  } catch (err) {
    // Log the failure
    if (invoice) {
      const vsdcErr = err instanceof VsdcError ? err : null;
      await admin
        .from("zra_invoices")
        .update({
          status: "failed",
          error_code: vsdcErr?.code ?? "UNKNOWN",
          error_message: (err as Error).message,
        })
        .eq("id", invoice.id);
    }

    if (err instanceof VsdcError) {
      return NextResponse.json(
        {
          ok: false,
          zraEnabled: true,
          error: err.message,
          code: err.code,
          // Still return ok:false but don't block the sale — the POS should
          // still print the receipt without a ZRA number and retry later.
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { ok: false, zraEnabled: true, error: "Unexpected error submitting to ZRA" },
      { status: 500 },
    );
  }
}
