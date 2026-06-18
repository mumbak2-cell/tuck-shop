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

In Supabase **SQL Editor**, run these files in order:

1. `supabase/migrations/001_create_tables.sql` — creates all tables
2. `supabase/migrations/002_rls_policies.sql` — enables row-level security
3. `supabase/migrations/003_seed_data.sql` — loads product catalog, ingredients, and recipes

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