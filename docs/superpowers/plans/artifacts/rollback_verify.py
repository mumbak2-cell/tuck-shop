#!/usr/bin/env python3
"""rollback_verify.py — dry-run assertion for rollback_119.sql.

Assumes the rig is already at: synth_schema.sql + 119 + rollback_119.sql
applied (see the sequence in rollback_119.sql's header / plan Task 12).
Dumps pg_policy from rls_rig, keeps only the tables migration 119 touches,
and asserts every row matches pg_policy_pre119.csv after whitespace/paren
normalisation (Postgres re-renders exprs on reparse). Exit 0 iff identical.
"""
import csv
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PRE_CSV = os.path.join(HERE, "pg_policy_pre119.csv")

TOUCHED = set("""
app_settings categories expense_categories ingredients locations payment_methods
production_log products purchases ra_notes recipes stock_receipt_items
stock_receipts suppliers balance_adjustments stock_adjustments sales combos
promotions purchase_orders location_settings report_subscriptions
product_location_prices wms_adjustments wms_catalog wms_dispatch_items
wms_dispatches wms_inventory wms_po_items wms_purchase_orders wms_receipt_items
wms_receipts wms_stock_count_audit wms_stock_counts wms_stock_count_sessions
wms_locations wms_org_settings zra_config zra_invoices combo_items
promotion_items purchase_order_items customer_payments customers shifts
daily_reconciliation stock_count_audit
""".split())


def norm(s):
    return " ".join((s or "").replace("(", " ").replace(")", " ").split())


def main():
    pre = {}
    with open(PRE_CSV, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["tbl"] in TOUCHED:
                pre[(r["tbl"], r["polname"], r["polcmd"])] = (norm(r["using_expr"]), norm(r["check_expr"]))

    q = ("SELECT c.relname||chr(9)||p.polname||chr(9)||p.polcmd::text||chr(9)||"
         "regexp_replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'[[:space:]]+',' ','g')||chr(9)||"
         "regexp_replace(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'[[:space:]]+',' ','g') "
         "FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid "
         "WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname,p.polcmd,p.polname;")
    out = subprocess.run(
        ["docker", "exec", "-i", "rls_rig", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q],
        capture_output=True, text=True, check=True).stdout
    post = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        t, pol, cmd, ql, ck = line.split("\t")
        if t in TOUCHED:
            post[(t, pol, cmd)] = (norm(ql), norm(ck))

    missing = sorted(set(pre) - set(post))
    extra = sorted(set(post) - set(pre))
    diff = [k for k in pre if k in post and pre[k] != post[k]]

    print(f"pre touched rows: {len(pre)}   post touched rows: {len(post)}")
    if missing:
        print(f"MISSING after rollback: {missing}")
    if extra:
        print(f"EXTRA after rollback: {extra}")
    for k in diff:
        print(f"MISMATCH {k}\n  pre : {pre[k]}\n  post: {post[k]}")

    if missing or extra or diff:
        print("ROLLBACK DRY-RUN: DIFF — not identical to pre-119")
        sys.exit(1)
    print("ROLLBACK DRY-RUN: IDENTICAL — every touched-table policy restored to pre-119 state.")


if __name__ == "__main__":
    main()
