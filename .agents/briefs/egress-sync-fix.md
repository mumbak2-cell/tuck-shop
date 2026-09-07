# Implementation brief — cut Supabase egress in the offline sync loop

**Author:** Opus planning session, 2026-09-07
**Builder:** Sonnet session
**Branch:** `perf/offline-sync-egress`
**Scope:** one PR, client-side only, no migration

---

## Why

Supabase org `BMK Org` used **5.83 GB egress against a 5 GB Free-plan cap (117%)** in the
18 Aug – 18 Sep 2026 cycle. Grace period ends **07 Oct 2026**, after which requests return
**402**. Measured on the dashboard the same day:

| Metric | Value |
|---|---|
| Egress | 5.83 / 5 GB |
| Realtime messages | 0 |
| Realtime connections | 0 |
| Edge function invocations | 0 |
| Cached egress | 0 |
| Database size | 72.8 MB |
| Storage | 13 MB |
| Auth users | 46 |
| MAU | 40 |

Realtime, storage and edge functions are all zero, so essentially the whole 5.83 GB is
PostgREST traffic. The whole database is 72.8 MB — it was transferred roughly 80 times over.

The cause is `src/lib/offline-sync.ts`. `refreshCache()` re-downloads entire tables with
`select("*")` on a 5-minute interval, with no delta filter, no location scoping, and no idle
check. `startSyncLoop` is called from `OrgProvider` (`src/lib/org-context.tsx:400`), which is
mounted in the **root** layout (`src/app/layout.tsx:56`) — so the loop runs on every signed-in
page, not just the till, and keeps running in a background tab overnight (288 full catalogue
downloads per day per tab).

**The app's own online POS path already does the right thing.** `src/app/(dashboard)/pos/page.tsx:136-141`
fetches stock as `.select("product_id, quantity").eq("location_id", currentLocationId).gt("quantity", 0)`.
The sync loop is the inconsistent one. These three fixes make the sync match the behaviour POS
already relies on.

## Goal

Get egress under 5 GB/cycle without changing what any screen displays, online or offline.

---

## Constraints

- **Client-side only.** No migration in this PR. Delta sync on `updated_at` is a separate,
  later change because it needs a new column and trigger on `products`.
- `main` auto-deploys production. **Do not merge during trading hours.** Open the PR; Mumba
  merges.
- Surgical: touch `src/lib/offline-sync.ts` and `src/lib/org-context.tsx` only. Do not
  refactor adjacent code, do not reformat, do not "improve" the cache layer.
- Do not change `src/lib/offline-store.ts`, `src/lib/fetch-all.ts`, or any page component.

---

## Fix 1 — stop refreshing the cache while the tab is hidden

**File:** `src/lib/offline-sync.ts`

Currently `setInterval` (line 155) calls `syncOnce` every 5 minutes regardless of whether
anyone is looking at the page.

Required behaviour:

1. On each interval tick, **skip `refreshCache` when `document.hidden === true`**.
2. **Still drain the write queue on every tick**, hidden or not. This is the part that must
   not regress: queued offline sales have to flush even if the till tab is backgrounded.
   `syncOnce()` currently does `refreshCache` then `drainQueue` behind one `inFlight` lock —
   split the visibility check so only the refresh is skipped, never the drain.
3. Add a `visibilitychange` listener that runs one `syncOnce` when the document becomes
   visible again, so a tab returning to the foreground is not showing up to 5-minute-stale
   stock. Remove the listener in the cleanup function returned by `startSyncLoop`, alongside
   the existing `online` and `tilify:queue-changed` teardown.

Do not change `CACHE_REFRESH_INTERVAL_MS` or `COLD_REFRESH_MS` in this PR.

**Watch for:** `lastColdRefresh` is module state. Confirm a long hidden period followed by a
visibility-triggered sync still refreshes the cold set correctly rather than skipping it.

## Fix 2 — scope stock and price rows to the current location

**File:** `src/lib/offline-sync.ts` lines 45-58, plus the call site in `src/lib/org-context.tsx:400`

`product_stock` is fetched for **every location** (line 50), and so is
`product_location_prices` (line 56). The only consumer is the POS, and it already discards
every other location client-side (`src/app/(dashboard)/pos/page.tsx:87-95`). The multiplier
is the org's location count.

Required behaviour:

1. Give `refreshCache` a second parameter, the current location id, and add
   `.eq("location_id", locationId)` to the `product_stock` and `product_location_prices`
   fetches when it is non-null.
2. When the location id **is** null, keep today's behaviour (fetch all) — `pos/page.tsx:95`
   falls back to unfiltered when `currentLocationId` is null, so the cache must still hold
   something usable.
3. Thread it through: `startSyncLoop(orgId, locationId)`, and in `org-context.tsx` pass
   `state.currentLocationId`. Add `state.currentLocationId` to that `useEffect` dependency
   array so switching branch restarts the loop with the new scope.
4. Clear or overwrite the cached `product_stock` / `product_location_prices` on location
   switch. The loop restart already calls `syncOnce` immediately, which overwrites via
   `saveCache` — confirm that lands before any POS read, and that a cashier switching branch
   cannot briefly see the previous branch's stock.

**Check before you write:** `OrgState.stockMode` can be `"central"` (one shared pool across
shops). Verify the POS online path treats central mode the same way — it appears to filter by
`currentLocationId` unconditionally at line 139, in which case scoping the cache matches. If
central mode genuinely needs cross-location stock, **stop and report** rather than scoping it.

## Fix 3 — select only the columns that are used

**File:** `src/lib/offline-sync.ts` lines 47, 50, 56

Replace `select("*")` with explicit column lists.

- `product_stock` — POS reads only `product_id`, `quantity`, `location_id`
  (`pos/page.tsx:94`). The online path uses `product_id, quantity` because location is already
  in the `WHERE`. Keep `location_id` in the cached shape only if fix 2 leaves the unfiltered
  fallback path in place.
- `product_location_prices` — POS reads `product_id`, `selling_price`, `location_id`
  (`pos/page.tsx:87`).
- `products` — **derive the list from actual usage, do not guess.** The `Product` interface is
  at `src/types/database.ts:78` (22 fields). Grep every consumer of the `products` cache
  (`pos/page.tsx:84`, `pos/page.tsx:352` in `components/pos/payment-modal.tsx`, and anything
  else `readCache(orgId, "products")` reaches) and include exactly the fields they touch.
  `cost_per_unit`, `package_price`, `qty_in_pack`, `recipe_cost_per_unit`, `units_per_batch`
  and `default_supplier` look like margin/purchasing fields the till never renders — confirm,
  then drop them.

If narrowing `products` turns out to need most of the interface anyway, say so in the PR and
leave that one as `select("*")`. Fixes 1 and 2 carry the bulk of the saving.

---

## Explicitly out of scope

- Delta / incremental sync (`updated_at` filter). Needs a migration; separate PR.
- Changing the 5-minute or 30-minute intervals.
- `fetchAllPaged` page size or hard cap.
- The `select("*")` calls on dashboard pages. They run per navigation, not on a timer, and
  are not the leak.
- IndexedDB migration, realtime, or any caching layer.

---

## Verification — required before opening the PR

Success criterion: **the till behaves identically, and per-cycle egress drops.**

1. `npm run build` and `npx tsc --noEmit` both clean.
2. `npm run lint` clean.
3. **Network measurement, the decisive check.** Open the app, DevTools → Network, filter to
   `rest/v1`. Record total transferred bytes over one 5-minute cycle, on `main` and again on
   the branch, same org, same branch, same catalogue. Put both numbers and the percentage
   reduction in the PR description. A branch with no measured reduction has not fixed anything.
4. Background the tab for one full interval and confirm in Network that **no** `products` /
   `product_stock` request fires, and that a queued write still flushes.
5. Foreground the tab and confirm exactly one refresh fires.
6. POS online: products list, stock levels, and per-branch prices identical to `main`.
7. POS offline (DevTools → Offline): products render from cache, stock filtered to the
   current branch, a sale queues, and it flushes on reconnect.
8. Switch branch as an owner and confirm stock/prices update to the new branch and never
   show the previous branch's figures.

Do not claim any of these pass without pasting the actual output or byte figures.

---

## PR

- Branch `perf/offline-sync-egress`, one PR, do not merge.
- Title: `perf: cut offline-sync egress (visibility gate, location scoping, narrowed selects)`
- Body must include the before/after byte measurement from step 3 and the per-fix reasoning.
- Flag anything you chose not to do and why.
