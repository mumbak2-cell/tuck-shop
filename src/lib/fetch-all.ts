// Helper that bypasses Supabase's server-side max_rows ceiling (default 1000)
// by paginating with .range() until the table is exhausted. Use this when an
// operator legitimately has more than 1000 rows in a table — products,
// product_stock, customers at a chain — and the page or export needs them all.
//
// Usage:
//   const all = await fetchAllPaged<Product>(() =>
//     db.from("products").select("*").eq("discontinued", false).order("inventory_id")
//   );

const DEFAULT_PAGE = 1000;
const HARD_CAP = 200000; // absolute safety stop so a runaway never spins forever

// The factory MUST rebuild the query each call — Supabase builders are
// single-shot. We type it loosely because the postgrest builder generics
// shift between supabase-js versions; a precise type at the call site is
// not worth fighting for an internal pagination helper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryFactory = () => any;

export async function fetchAllPaged<T>(
  buildQuery: QueryFactory,
  pageSize: number = DEFAULT_PAGE
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (from < HARD_CAP) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = (data as T[]) ?? [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
