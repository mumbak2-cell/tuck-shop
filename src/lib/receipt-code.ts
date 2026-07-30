/**
 * Short, readable receipt code taken from a UUID — the last six hex digits,
 * e.g. "3F9A2C". Printed on the receipt and used to pull the sale back up when
 * a customer returns something.
 *
 * Derived rather than stored so no new column or sale-RPC argument is needed.
 * Six hex digits is 16.7M combinations, which is ample for one shop's history;
 * the lookup returns every match rather than assuming uniqueness.
 */
export function receiptCode(id: string): string {
  return id.replace(/-/g, "").slice(-6).toUpperCase();
}

/** Accepts what a cashier might type: spaces, a leading #, lower case. */
export function normaliseReceiptCode(input: string): string {
  return input.trim().replace(/^#/, "").replace(/\s+/g, "").toUpperCase();
}
