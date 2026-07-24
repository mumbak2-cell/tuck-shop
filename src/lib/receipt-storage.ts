import { db, supabase } from "@/lib/supabase";

/**
 * Delete a receipt file, but only once no row still points at it.
 *
 * Receive Stock copies its `receipt_path` onto the "Stock Purchases" expense it
 * auto-creates, so a single object is routinely referenced twice. Deleting one
 * of those rows must not strand the other with a link to a file that is gone.
 *
 * Call this *after* the owning row has been deleted, so the remaining count is
 * exactly the set of rows that still need the file.
 *
 * Deliberately conservative: if either count query fails we cannot prove the
 * object is unreferenced, so we leave it. An orphaned file wastes a little
 * storage; deleting one that is still referenced breaks a receipt for good.
 */
export async function deleteReceiptIfUnreferenced(path: string): Promise<void> {
  const [expenses, receipts] = await Promise.all([
    db.from("expenses").select("id", { count: "exact", head: true }).eq("receipt_path", path),
    db.from("stock_receipts").select("id", { count: "exact", head: true }).eq("receipt_path", path),
  ]);

  if (expenses.error || receipts.error) return;
  if ((expenses.count ?? 0) + (receipts.count ?? 0) > 0) return;

  await supabase.storage.from("receipts").remove([path]);
}

/**
 * Discard a file that was uploaded but never saved against a row — the upload
 * happens the moment a file is picked, so abandoning the form would otherwise
 * leave an object nothing references. Safe to call unconditionally: it is only
 * ever handed a path that has not been written to a row yet.
 */
export async function discardUnsavedReceipt(path: string): Promise<void> {
  await supabase.storage.from("receipts").remove([path]);
}
