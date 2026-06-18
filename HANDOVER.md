# Tilify (formerly Tuck Shop App) — Handover Document

## Project Overview

A PWA (Progressive Web App) for managing a tuck shop / small retail operation. Built for MK Global SA (Pty) Ltd. The app runs on tablets/phones at the counter and handles point-of-sale, stock management, credit customers, expenses, and revenue assurance.

**Live URL:** https://tuck-shop-tau.vercel.app/
**Repo:** GitHub (private) — `tuck-shop`
**Hosting:** Vercel (auto-deploys on `git push` to `main`)

---

## Tech Stack

- **Framework:** Next.js 16.2.6 (App Router, Turbopack)
- **Language:** TypeScript (strict mode)
- **Styling:** Tailwind CSS 4
- **Database:** Supabase (PostgreSQL) — project ID: `kepddgyckksidponheha`
- **Supabase URL:** `https://kepddgyckksidponheha.supabase.co`
- **Auth:** PIN-based (no Supabase Auth — custom PIN pad with sessionStorage)
- **Default PINs:** Admin = `1234`, Cashier = `0000` (configurable in Settings)
- **Currency:** South African Rand (ZAR/R) via `formatZAR()` helper
- **PWA:** Service worker + manifest for installability

---

## Key Architecture Decisions

### Supabase Client (IMPORTANT)

`src/lib/supabase.ts` exports two clients:
- `supabase` — typed with `Database` generic. **UNUSED** but still exported (harmless).
- `db` — untyped, cast `as any`. **ALL files use this one.**

The typed client caused `never` type errors because the generated types didn't match the actual schema after Phase 5 additions. The untyped `db` client bypasses this.

**Rule:** ALL new code must use `db`, never `supabase`. Import as `import { db } from "@/lib/supabase"`.

### TypeScript Strict Mode

`tsconfig.json` has `"strict": true` which enables `noImplicitAny`. Every callback parameter on `db` query results needs explicit `: any` annotations:
```typescript
const products: any[] = data || [];
products.filter((p: any) => p.opening_stock > 0)
products.reduce((sum: number, p: any) => sum + p.amount, 0)
((data || []) as any[]).forEach((row: any) => { ... })
```

### RLS (Row Level Security)

All tables have RLS enabled with open "Allow all" policies (single-user system). **Every new table needs RLS policies** or writes will silently fail:
```sql
ALTER TABLE new_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on new_table" ON new_table FOR ALL USING (true) WITH CHECK (true);
```

### Voided Sales

Sales have a `voided` boolean column. All sales queries across the app (dashboard, P&L, revenue assurance, credit ledger, reports) filter with `.eq("voided", false)`. Any new sales query must include this filter.

---

## Project Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout (AuthProvider + ShiftProvider)
│   ├── page.tsx                # Redirects to /dashboard
│   └── (dashboard)/
│       ├── layout.tsx          # Sidebar wrapper
│       ├── dashboard/          # Main dashboard with stats, charts, reports
│       ├── shift/              # Open/close shift management
│       ├── pos/                # Point of Sale (blocked without open shift)
│       ├── sales/              # Today's sales + till reconciliation + void
│       ├── stock/              # Stock count (admin only)
│       ├── receive-stock/      # Receive deliveries (products + ingredients)
│       ├── stock-adjustments/  # Breakage, expired, theft, corrections
│       ├── products/           # Product CRUD + CSV import
│       ├── ingredients/        # Ingredient management
│       ├── customers/          # Customer CRUD + balance carry-forward
│       ├── expenses/           # Expense tracking + director withdrawals
│       ├── credit-ledger/      # Credit sales/payments table + export
│       ├── profit-loss/        # P&L report (today/week/month/custom)
│       ├── revenue-assurance/  # Stock vs POS comparison
│       ├── stockpilot-import/  # Import from StockPilot offline app
│       └── settings/           # PINs, iKhokha link, business details
├── components/
│   ├── auth/pin-pad.tsx        # PIN login screen
│   ├── layout/sidebar.tsx      # Navigation sidebar with role-based items
│   ├── pos/
│   │   ├── cart.tsx            # Shopping cart
│   │   ├── payment-modal.tsx   # Payment flow (cash/card/credit + change calc)
│   │   └── product-grid.tsx    # POS product grid with category tabs
│   ├── products/
│   │   ├── product-form.tsx    # Add/edit product form
│   │   └── csv-upload.tsx      # CSV bulk import modal
│   └── ui/                     # Shared UI components (Button, Modal, Input, Badge, Select)
├── lib/
│   ├── supabase.ts             # Supabase clients (use `db` only)
│   ├── auth-context.tsx        # PIN-based auth context
│   ├── shift-context.tsx       # Shift open/close state
│   └── format.ts               # formatZAR(), formatDate() helpers
└── types/
    └── database.ts             # TypeScript types (Product, Customer, etc.)
```

---

## Database Tables

### Core (Phase 1-4)
- `products` — inventory items with stock levels, prices, categories
- `ingredients` — raw ingredients for prepared items
- `recipes` / `production_log` — recipe management (basic)
- `customers` — credit customers with balance and credit limit
- `sales` — individual sale line items (has `voided` columns)
- `customer_payments` — payment records against customer balances
- `stock_counts` — daily stock counts (has audit columns: `counted_by`, `counted_at`, `update_count`)
- `daily_reconciliation` — till reconciliation (float, expected vs actual cash)
- `purchases` — legacy purchasing table

### Phase 5
- `app_settings` — key-value settings (PINs, iKhokha link, business name)
- `expenses` — expense tracking with categories including Director Withdrawal
- `stock_receipts` / `stock_receipt_items` — receiving deliveries
- `stock_count_audit` — tracks every edit to stock counts (old value, new value, who, when)
- `shifts` — shift open/close with timestamps, float, closing cash, stock count status
- `stock_adjustments` — breakage, expired, theft, corrections with audit trail

### SQL Migrations (in order)
1. `001_create_tables.sql` — core tables
2. `002_rls_policies.sql` — RLS for core tables
3. `003_seed_data.sql` — initial product data
4. `004_deduct_stock_rpc.sql` — `deduct_stock` RPC
5. `005_stock_counts_unique.sql` — unique constraint on stock_counts
6. `006_phase5_tables.sql` — Phase 5 tables + RPCs (`add_product_stock`, `add_ingredient_stock`)
7. `007_phase5_rls.sql` — RLS for Phase 5 tables
8. `008_reset_for_june.sql` — data reset script (don't re-run)
9. `009_stock_count_audit.sql` — audit columns + audit log table
10. `010_void_sales.sql` — voided/voided_at/voided_by/void_reason on sales
11. `011_shifts.sql` — shifts table
12. `012_stock_adjustments.sql` — stock_adjustments table
13. `013_stock_count_sessions.sql` — session_id + session_label on stock_counts (allows multiple counts per day)

---

## Features by Role

### Cashier (PIN: 0000)
- Dashboard (view only)
- Shift (open/close)
- Point of Sale (cash tendered + change calculation)
- Today's Sales (view only, no void)

### Admin (PIN: 1234)
- Everything cashier can do, plus:
- Void sales (with reason, stock reversal, credit balance adjustment)
- Stock Count (manual in-app)
- Receive Stock (products at pack cost, prepared items at zero cost)
- Stock Adjustments (breakage, expired, theft, corrections)
- Products / Ingredients management
- Customers (with balance carry-forward)
- Expenses (with director withdrawals)
- Credit Ledger (table view, grouped lines, brought-forward balance, Excel export, WhatsApp statement)
- Profit & Loss report
- Revenue Assurance (select opening/closing stock counts, compare vs POS)
- StockPilot Import
- Settings
- CSV Import/Export
- Dashboard report downloads (daily sales, stock levels, credit outstanding, P&L)

---

## Key Business Logic

### Stock Flow
- **Opening stock** = yesterday's closing count
- **Receive Stock** multiplies packs × `qty_in_pack` for total units added
- **Prepared items** (is_prepared=true) can be restocked at zero cost
- **Sales** deduct stock via `deduct_stock` RPC (fallback: manual decrement)
- **Void** returns stock to product
- **Stock adjustments** add/remove with reason and audit trail

### Revenue Assurance Formula
```
Units Sold = Opening Stock + Replenished − Closing Stock
Expected Revenue = Units Sold × Selling Price
Unrecorded = Units Sold − POS Recorded Sales
```
User selects opening and closing stock counts from dropdowns (with date + time + who counted).

### Shift Flow
1. Open shift → enter float → POS unlocked
2. During shift → sell, receive stock, adjust
3. Before closing → stock count required (in-app or StockPilot)
4. Close shift → enter closing cash → shift locked
5. POS blocked without open shift

### Credit Sales
- Customer balance increases on credit sale
- Balance decreases on payment
- Void reverses customer balance
- Brought-forward balance calculated from all transactions before the filter period
- WhatsApp invoices/statements include iKhokha payment link

---

## Common Operations

### Deploy changes
```bash
rmdir /s /q .next        # Clear cache (OneDrive can lock files)
npm run build             # Verify no errors
git add .
git commit -m "description"
git push                  # Vercel auto-deploys
```

### Add a new database table
1. Create migration SQL in `supabase/migrations/`
2. Run it in Supabase SQL Editor
3. **Add RLS policy** (or writes will silently fail)
4. Use `db` client in code, add `: any` to all callback params

### Reset data for new month
Run the reset script (like 008) but update for current month. Clears sales, expenses, stock counts, receipts, payments, reconciliation. Resets customer balances and product stock to 0. Then upload opening stock via CSV.

---

## Known Issues / Watch-outs

1. **OneDrive file locking** — `npm run build` can fail with EPERM errors. Fix: `rmdir /s /q .next` then rebuild.
2. **Never use `replace_all` with `supabase` → `db`** — it corrupts import paths like `"@/lib/supabase"` to `"@/lib/db"`.
3. **Stock counts use session_id** — each count event gets a unique `session_id`, allowing multiple counts per day (opening count, closing count, recount). The unique constraint is `(session_id, product_id)`. Revenue Assurance groups by session with timestamps.
4. **`opening_units` in stock_counts** is a snapshot at count time — it already includes any restocks done that day.
5. **Prepared items** need the `is_prepared` checkbox ticked in the product form to appear in the "Prepared Items (no cost)" section of Receive Stock.

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=https://kepddgyckksidponheha.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtlcGRkZ3lja2tzaWRwb25oZWhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3NTIzOTMsImV4cCI6MjA5NTMyODM5M30.K189kQ_Wf0udUKr64ft9c3eDpM0TgrAt84-JeltZMtU
```

These are set in Vercel under Project Settings → Environment Variables, and locally in `.env.local`.
