# Tilify — Inventory, POS and Revenue Assurance

Tilify is the MK Global SA SaaS for small retailers and tuck-shop operators across SADC. PWA built with Next.js, Supabase, and Tailwind CSS. (Formerly the "Tuck Shop" project — folder name remains `tuck-shop` for git history continuity; rename the working folder separately if desired.)

## Setup Instructions

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Once created, go to **Settings → API** and copy:
   - Project URL
   - `anon` public API key

### 2. Install Dependencies

```bash
cd tuck-shop
npm install
```

### 3. Configure Environment

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and paste your Supabase URL and anon key.

### 4. Run Database Migrations

In Supabase **SQL Editor**, run every file in `supabase/migrations/` in filename order, starting with:

1. `supabase/migrations/001_create_tables.sql` — creates all tables
2. `supabase/migrations/002_rls_policies.sql` — enables row-level security
3. `supabase/migrations/003_seed_data.sql` — loads product catalog, ingredients, and recipes

#### Migration numbering

One migration per number, and **never reuse a number**. Filename order is apply
order, so a collision makes the sequence ambiguous and breaks a rebuild from
scratch. It also makes the files unusable by `supabase db push`, which treats
the prefix as a unique version.

Three numbers were reused historically (023, 028, 029) and have been
disambiguated by widening the prefix rather than renumbering everything after
them: `0230_locations.sql` and `0231_wms_tables.sql` both still sort between
`022_` and `024_`. Prefer a plain sequential number for anything new.

### 5. Start Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 6. Deploy to Vercel (when ready)

```bash
npx vercel
```

Add your `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` as environment variables in the Vercel dashboard.

## Project Structure

```
tuck-shop/
├── public/
│   ├── manifest.json          # PWA manifest
│   └── sw.js                  # Service worker (offline support)
├── src/
│   ├── app/
│   │   ├── (dashboard)/
│   │   │   �