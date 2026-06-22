// Daily report builder. Server-side ONLY (uses supabaseAdmin to bypass RLS).
// Aggregates yesterday's sales, expenses, and stock adjustments for an org,
// produces a small structured summary and an HTML email body.

import { getSupabaseAdmin } from "@/lib/supabase-admin";

export interface LocationSummary {
  locationId: string;
  locationName: string;
  revenue: number;
  transactionCount: number;
  paymentMethodBreakdown: Record<string, number>;
  topProducts: Array<{ name: string; units: number; revenue: number }>;
  expensesTotal: number;
  adjustmentsLoss: number;
}

export interface OrgDailySummary {
  orgId: string;
  orgName: string;
  currency: string;
  reportDate: string; // YYYY-MM-DD
  totalRevenue: number;
  totalTransactions: number;
  totalExpenses: number;
  totalAdjustmentsLoss: number;
  locations: LocationSummary[];
}

function yesterdayDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

function fmtMoney(amount: number, currency: string): string {
  const SYMBOLS: Record<string, string> = {
    ZAR: "R", BWP: "P", NAD: "N$", ZMW: "K", MZN: "MT",
    MWK: "MK", ZWG: "ZiG", LSL: "L", SZL: "E", AOA: "Kz",
    CDF: "FC", MGA: "Ar", MUR: "₨", SCR: "₨", TZS: "TSh",
  };
  const sym = SYMBOLS[currency] || currency + " ";
  return `${sym}${amount.toFixed(2)}`;
}

/**
 * Build the structured summary for an org for a given date (defaults to
 * yesterday). Returns null when the org has no data for the day (nothing
 * worth emailing).
 */
export async function buildDailySummary(orgId: string, isoDate?: string): Promise<OrgDailySummary | null> {
  const supabase = getSupabaseAdmin();
  const date = isoDate ?? yesterdayDate();

  // Org metadata
  const { data: org } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("id", orgId)
    .single();
  if (!org) return null;

  // Currency from app_settings
  const { data: currencyRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("org_id", orgId)
    .eq("key", "currency")
    .maybeSingle();
  const currency = (currencyRow?.value || "ZAR").toUpperCase();

  // Locations
  const { data: locRows } = await supabase
    .from("locations")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("active", true)
    .order("sort_order");
  const locations = (locRows as Array<{ id: string; name: string }>) || [];
  if (locations.length === 0) return null;

  // Yesterday's sales for this org
  const { data: salesRows } = await supabase
    .from("sales")
    .select("location_id, total_amount, payment_method, product_id, quantity")
    .eq("org_id", orgId)
    .eq("sale_date", date);
  const sales = salesRows || [];

  // Lookup product names for the top-products list
  const productIds = Array.from(new Set(sales.map((s: { product_id?: string }) => s.product_id).filter(Boolean))) as string[];
  const productNames: Record<string, string> = {};
  if (productIds.length > 0) {
    const { data: prodRows } = await supabase
      .from("products")
      .select("id, name")
      .in("id", productIds);
    ((prodRows as Array<{ id: string; name: string }>) || []).forEach((p) => {
      productNames[p.id] = p.name;
    });
  }

  // Yesterday's expenses
  const { data: expRows } = await supabase
    .from("expenses")
    .select("location_id, amount")
    .eq("org_id", orgId)
    .eq("expense_date", date);
  const expenses = expRows || [];

  // Yesterday's stock adjustments (count only losses, i.e. direction='decrease')
  const { data: adjRows } = await supabase
    .from("stock_adjustments")
    .select("location_id, quantity, direction, products(selling_price)")
    .eq("org_id", orgId)
    .eq("adjustment_date", date);
  const adjustments = (adjRows as any[]) || [];

  const locSummaries: LocationSummary[] = locations.map((loc) => {
    const locSales = sales.filter((s: { location_id?: string }) => s.location_id === loc.id);
    const revenue = locSales.reduce((sum: number, s: { total_amount?: number }) => sum + (Number(s.total_amount) || 0), 0);
    const transactionCount = locSales.length;

    const paymentMethodBreakdown: Record<string, number> = {};
    locSales.forEach((s: { payment_method?: string; total_amount?: number }) => {
      const method = s.payment_method || "Unknown";
      paymentMethodBreakdown[method] = (paymentMethodBreakdown[method] || 0) + (Number(s.total_amount) || 0);
    });

    // Top 5 products by revenue at this location
    const productAgg: Record<string, { units: number; revenue: number }> = {};
    locSales.forEach((s: { product_id?: string; quantity?: number; total_amount?: number }) => {
      if (!s.product_id) return;
      if (!productAgg[s.product_id]) productAgg[s.product_id] = { units: 0, revenue: 0 };
      productAgg[s.product_id].units += Number(s.quantity) || 0;
      productAgg[s.product_id].revenue += Number(s.total_amount) || 0;
    });
    const topProducts = Object.entries(productAgg)
      .map(([id, agg]) => ({ name: productNames[id] || id, ...agg }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const locExpenses = expenses
      .filter((e: { location_id?: string }) => e.location_id === loc.id)
      .reduce((sum: number, e: { amount?: number }) => sum + (Number(e.amount) || 0), 0);

    const adjustmentsLoss: number = adjustments
      .filter((a: any) => a.location_id === loc.id && a.direction === "decrease")
      .reduce((sum: number, a: any) => {
        // products may come back as an object or an array depending on FK direction
        const productRel = Array.isArray(a.products) ? a.products[0] : a.products;
        const sellPrice = Number(productRel?.selling_price) || 0;
        return sum + sellPrice * (Number(a.quantity) || 0);
      }, 0);

    return {
      locationId: loc.id,
      locationName: loc.name,
      revenue,
      transactionCount,
      paymentMethodBreakdown,
      topProducts,
      expensesTotal: locExpenses,
      adjustmentsLoss,
    };
  });

  const totalRevenue = locSummaries.reduce((s, l) => s + l.revenue, 0);
  const totalTransactions = locSummaries.reduce((s, l) => s + l.transactionCount, 0);
  const totalExpenses = locSummaries.reduce((s, l) => s + l.expensesTotal, 0);
  const totalAdjustmentsLoss = locSummaries.reduce((s, l) => s + l.adjustmentsLoss, 0);

  // If absolutely nothing happened yesterday, skip the email.
  if (totalRevenue === 0 && totalTransactions === 0 && totalExpenses === 0 && totalAdjustmentsLoss === 0) {
    return null;
  }

  return {
    orgId,
    orgName: org.name,
    currency,
    reportDate: date,
    totalRevenue,
    totalTransactions,
    totalExpenses,
    totalAdjustmentsLoss,
    locations: locSummaries,
  };
}

/**
 * Render the structured summary as an HTML email body. Tilify-branded,
 * inline styles only (gmail does not load <style>).
 */
export function renderDailyEmail(summary: OrgDailySummary): { subject: string; html: string; text: string } {
  const c = summary.currency;
  const money = (n: number) => fmtMoney(n, c);
  const isMulti = summary.locations.length > 1;

  const subject = `${summary.orgName} — Daily summary for ${summary.reportDate}`;

  const locationBlocks = summary.locations.map((loc) => {
    const methodRows = Object.entries(loc.paymentMethodBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([method, amount]) => `<li style="margin:2px 0;">${escapeHtml(method)}: <strong>${money(amount)}</strong></li>`)
      .join("");

    const topRows = loc.topProducts
      .map((p, i) => `<tr><td style="padding:4px 8px;color:#9ca3af;">${i + 1}.</td><td style="padding:4px 8px;">${escapeHtml(p.name)}</td><td style="padding:4px 8px;text-align:right;color:#6b7280;">${p.units}</td><td style="padding:4px 8px;text-align:right;font-weight:600;">${money(p.revenue)}</td></tr>`)
      .join("");

    return `
      <div style="margin-top:24px;padding:16px;border:1px solid #e5e7eb;border-radius:12px;">
        <h3 style="margin:0 0 12px 0;color:#1f3864;font-size:16px;">${escapeHtml(loc.locationName)}</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Revenue</td>
            <td style="padding:4px 0;text-align:right;font-weight:700;color:#16a34a;">${money(loc.revenue)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Transactions</td>
            <td style="padding:4px 0;text-align:right;">${loc.transactionCount}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Expenses recorded</td>
            <td style="padding:4px 0;text-align:right;">${money(loc.expensesTotal)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Stock loss (adjustments)</td>
            <td style="padding:4px 0;text-align:right;color:${loc.adjustmentsLoss > 0 ? '#dc2626' : '#6b7280'};">${money(loc.adjustmentsLoss)}</td>
          </tr>
        </table>
        ${methodRows ? `<div style="margin-top:12px;padding-top:12px;border-top:1px dashed #e5e7eb;"><div style="font-size:12px;color:#6b7280;margin-bottom:4px;">Payment methods</div><ul style="list-style:none;padding:0;margin:0;font-size:13px;">${methodRows}</ul></div>` : ""}
        ${topRows ? `<div style="margin-top:12px;padding-top:12px;border-top:1px dashed #e5e7eb;"><div style="font-size:12px;color:#6b7280;margin-bottom:4px;">Top products</div><table style="width:100%;border-collapse:collapse;font-size:13px;">${topRows}</table></div>` : ""}
      </div>
    `;
  }).join("");

  const rollupBlock = isMulti ? `
    <div style="margin-top:24px;padding:16px;background:#f0fdf4;border:1px solid #86efac;border-radius:12px;">
      <h3 style="margin:0 0 12px 0;color:#14532d;font-size:16px;">Chain total</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:4px 0;color:#374151;">Revenue across all shops</td><td style="padding:4px 0;text-align:right;font-weight:700;color:#16a34a;font-size:18px;">${money(summary.totalRevenue)}</td></tr>
        <tr><td style="padding:4px 0;color:#374151;">Total transactions</td><td style="padding:4px 0;text-align:right;">${summary.totalTransactions}</td></tr>
        <tr><td style="padding:4px 0;color:#374151;">Total expenses</td><td style="padding:4px 0;text-align:right;">${money(summary.totalExpenses)}</td></tr>
        <tr><td style="padding:4px 0;color:#374151;">Total stock loss</td><td style="padding:4px 0;text-align:right;color:${summary.totalAdjustmentsLoss > 0 ? '#dc2626' : '#374151'};">${money(summary.totalAdjustmentsLoss)}</td></tr>
      </table>
    </div>
  ` : "";

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:24px;">
      <div style="background:white;padding:24px;border-radius:16px;border:1px solid #e5e7eb;">
        <div style="border-bottom:2px solid #16a34a;padding-bottom:12px;margin-bottom:8px;">
          <h1 style="margin:0;color:#1f3864;font-size:22px;">Tilify daily summary</h1>
          <p style="margin:4px 0 0 0;color:#6b7280;font-size:14px;">${escapeHtml(summary.orgName)} · ${summary.reportDate}</p>
        </div>
        ${rollupBlock}
        ${locationBlocks}
        <p style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
          You are receiving this because you enabled the daily digest in Tilify Settings.
          To turn it off, sign in and toggle Daily Email Digest off.
        </p>
      </div>
    </div>
  </body></html>`;

  const text = [
    `${summary.orgName} — Daily summary for ${summary.reportDate}`,
    "",
    isMulti ? `CHAIN TOTAL` : ``,
    `Revenue: ${money(summary.totalRevenue)}`,
    `Transactions: ${summary.totalTransactions}`,
    `Expenses: ${money(summary.totalExpenses)}`,
    `Stock loss: ${money(summary.totalAdjustmentsLoss)}`,
    ``,
    ...summary.locations.flatMap((loc) => [
      `--- ${loc.locationName} ---`,
      `Revenue: ${money(loc.revenue)}  Transactions: ${loc.transactionCount}`,
      `Expenses: ${money(loc.expensesTotal)}  Stock loss: ${money(loc.adjustmentsLoss)}`,
      ...loc.topProducts.slice(0, 3).map((p, i) => `${i + 1}. ${p.name} - ${p.units} units, ${money(p.revenue)}`),
      ``,
    ]),
    `Manage this email in Tilify Settings.`,
  ].join("\n");

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
