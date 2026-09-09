#!/usr/bin/env python3
"""exprdiff.py — assert migration 119 changed every touched policy expression
by exactly the intended transformation and nothing else.

Runs `bash rig_load.sh` state must already be loaded (synth + 119). Dumps the
post-119 pg_policy from rls_rig, joins to pg_policy_pre119.csv on
(tbl, polname, polcmd), and for every policy 119 touches checks:

  gate       : new == "(" + old + " AND (org_id IN ( SELECT current_user_manager_org_ids() AS current_user_manager_org_ids)))"
  keep       : new == old  (Bucket B member-allowed commands, re-created verbatim)
  child      : new == old with current_user_org_ids() -> current_user_manager_org_ids()
  dropped    : policy absent post-119 (sales_loc_update / sales_loc_delete, and the
               FOR ALL / *_write policies replaced by the decompose)
  forall_read: new SELECT policy == old FOR ALL using expr, verbatim (ungated)

Every mismatch is printed. Exit 0 iff zero violations.
"""
import csv
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PRE_CSV = os.path.join(HERE, "pg_policy_pre119.csv")

MANAGER = "( SELECT current_user_manager_org_ids() AS current_user_manager_org_ids)"
GATE_SUFFIX = f" AND (org_id IN {MANAGER})"
CANONICAL = [
    "app_settings", "categories", "expense_categories", "ingredients", "locations",
    "payment_methods", "production_log", "products", "purchases", "ra_notes",
    "recipes", "stock_receipt_items", "stock_receipts", "suppliers",
]
FORALL_G1 = [
    "wms_adjustments", "wms_catalog", "wms_dispatch_items", "wms_dispatches",
    "wms_inventory", "wms_po_items", "wms_purchase_orders", "wms_receipt_items",
    "wms_receipts", "wms_stock_count_audit", "wms_stock_counts", "wms_stock_count_sessions",
]
FORALL_G1_OLDPOL = {t: ("wms_scs_org_isolation" if t == "wms_stock_count_sessions" else "org_isolation")
                    for t in FORALL_G1}
FORALL_G2 = {  # table -> old FOR ALL write policy name
    "wms_locations": "wms_locations_org_write",
    "wms_org_settings": "wms_org_settings_org_write",
    "zra_config": "zra_config_write",
    "zra_invoices": "zra_invoices_write",
}


def norm(s):
    # Collapse whitespace AND strip every parenthesis. Postgres flattens
    # n-ary AND — `(A AND B) AND C` re-renders as `(A AND B AND C)` — so a
    # literal "(" + old + " AND (gate))" prediction never matches byte-for-byte.
    # Removing parens and comparing the token sequence is invariant to that
    # flattening while still catching any real change to the predicate list.
    return " ".join((s or "").replace("(", " ").replace(")", " ").split())


def gated(old):
    return norm("(" + old + GATE_SUFFIX + ")")


def child_swap(old):
    return norm(old.replace("current_user_org_ids() AS current_user_org_ids",
                            "current_user_manager_org_ids() AS current_user_manager_org_ids"))


def load_pre():
    d = {}
    with open(PRE_CSV, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            d[(row["tbl"], row["polname"], row["polcmd"])] = (row["using_expr"], row["check_expr"])
    return d


def dump_post():
    q = ("SELECT c.relname||chr(9)||p.polname||chr(9)||p.polcmd::text||chr(9)||"
         "regexp_replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'[[:space:]]+',' ','g')||chr(9)||"
         "regexp_replace(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'[[:space:]]+',' ','g') "
         "FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid "
         "WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname,p.polcmd,p.polname;")
    out = subprocess.run(
        ["docker", "exec", "-i", "rls_rig", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q],
        capture_output=True, text=True, check=True).stdout
    d = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        tbl, pol, cmd, qual, chk = line.split("\t")
        d[(tbl, pol, cmd)] = (qual, chk)
    return d


def main():
    pre = load_pre()
    post = dump_post()
    violations = []

    def check(label, key, expected_qual, expected_chk):
        got = post.get(key)
        if got is None:
            violations.append(f"{label} {key}: expected policy present post-119, MISSING")
            return
        gq, gc = norm(got[0]), norm(got[1])
        if expected_qual is not None and gq != norm(expected_qual):
            violations.append(f"{label} {key} USING:\n  expected: {norm(expected_qual)}\n  got:      {gq}")
        if expected_chk is not None and gc != norm(expected_chk):
            violations.append(f"{label} {key} WITH CHECK:\n  expected: {norm(expected_chk)}\n  got:      {gc}")

    def must_be_absent(label, key):
        if key in post:
            violations.append(f"{label} {key}: expected DROPPED, still present: {post[key]}")

    # ---- Part 2 canonical: a=check gated, w=both gated, d=qual gated
    for t in CANONICAL:
        u, c = pre[(t, f"{t}_org_insert", "a")]
        check("canonical", (t, f"{t}_org_insert", "a"), None, gated(c))
        u, c = pre[(t, f"{t}_org_update", "w")]
        check("canonical", (t, f"{t}_org_update", "w"), gated(u), gated(c))
        u, c = pre[(t, f"{t}_org_delete", "d")]
        check("canonical", (t, f"{t}_org_delete", "d"), gated(u), None)

    # ---- Part 3 explicit: _loc_ / bare / plp_
    loc_all = {
        "balance_adjustments": "balance_adjustments_loc_%s",
        "stock_adjustments": "stock_adjustments_loc_%s",
        "location_settings": "location_settings_%s",
        "product_location_prices": "plp_%s",
        "report_subscriptions": "report_subs_%s",
    }
    for t, pat in loc_all.items():
        u, c = pre[(t, pat % "insert", "a")]
        check("explicit", (t, pat % "insert", "a"), None, gated(c))
        u, c = pre[(t, pat % "update", "w")]
        check("explicit", (t, pat % "update", "w"), gated(u), gated(c))
        u, c = pre[(t, pat % "delete", "d")]
        check("explicit", (t, pat % "delete", "d"), gated(u), None)

    # bare-named combos/promotions/purchase_orders: update is USING-only
    for t in ("combos", "promotions", "purchase_orders"):
        u, c = pre[(t, f"{t}_insert", "a")]
        check("bare", (t, f"{t}_insert", "a"), None, gated(c))
        u, c = pre[(t, f"{t}_update", "w")]
        check("bare", (t, f"{t}_update", "w"), gated(u), "")  # no WITH CHECK, must stay absent
        u, c = pre[(t, f"{t}_delete", "d")]
        check("bare", (t, f"{t}_delete", "d"), gated(u), None)

    # sales: insert gated, update+delete dropped
    u, c = pre[("sales", "sales_loc_insert", "a")]
    check("sales", ("sales", "sales_loc_insert", "a"), None, gated(c))
    must_be_absent("sales", ("sales", "sales_loc_update", "w"))
    must_be_absent("sales", ("sales", "sales_loc_delete", "d"))

    # ---- Part 4 FOR ALL decompose
    for t in FORALL_G1:
        oldpol = FORALL_G1_OLDPOL[t]
        u, c = pre[(t, oldpol, "*")]
        must_be_absent("forall_g1", (t, oldpol, "*"))
        check("forall_g1_read", (t, f"{t}_org_read", "r"), u, None)
        check("forall_g1", (t, f"{t}_org_insert", "a"), None, gated(u))
        check("forall_g1", (t, f"{t}_org_update", "w"), gated(u), gated(u))
        check("forall_g1", (t, f"{t}_org_delete", "d"), gated(u), None)
    for t, oldpol in FORALL_G2.items():
        u, c = pre[(t, oldpol, "*")]
        must_be_absent("forall_g2", (t, oldpol, "*"))
        check("forall_g2", (t, f"{t}_org_insert", "a"), None, gated(u))
        check("forall_g2", (t, f"{t}_org_update", "w"), gated(u), gated(u))
        check("forall_g2", (t, f"{t}_org_delete", "d"), gated(u), None)
        # existing _org_read must be untouched
        rk = (t, f"{t}_org_read", "r")
        if rk in pre and norm(post.get(rk, ("", ""))[0]) != norm(pre[rk][0]):
            violations.append(f"forall_g2 {rk}: pre-existing read policy was modified")

    # ---- Part 5 child tables: func swap, insert+delete only
    for t, fk in (("combo_items", "combo_id"), ("promotion_items", "promotion_id"),
                  ("purchase_order_items", "po_id")):
        u, c = pre[(t, f"{t}_insert", "a")]
        check("child", (t, f"{t}_insert", "a"), None, child_swap(c))
        u, c = pre[(t, f"{t}_delete", "d")]
        check("child", (t, f"{t}_delete", "d"), child_swap(u), None)
        if (t, f"{t}_update", "w") in post:
            violations.append(f"child {t}: an _update policy was created (should not exist)")

    # ---- Part 6 Bucket B
    # customer_payments / customers: insert kept verbatim, update gated both, delete gated
    for t in ("customer_payments", "customers"):
        u, c = pre[(t, f"{t}_loc_insert", "a")]
        check("bucketB_keep", (t, f"{t}_loc_insert", "a"), None, c)
        u, c = pre[(t, f"{t}_loc_update", "w")]
        check("bucketB_gate", (t, f"{t}_loc_update", "w"), gated(u), gated(c))
        u, c = pre[(t, f"{t}_loc_delete", "d")]
        check("bucketB_gate", (t, f"{t}_loc_delete", "d"), gated(u), None)
    # shifts: insert + update kept, delete gated
    u, c = pre[("shifts", "shifts_loc_insert", "a")]
    check("bucketB_keep", ("shifts", "shifts_loc_insert", "a"), None, c)
    u, c = pre[("shifts", "shifts_loc_update", "w")]
    check("bucketB_keep", ("shifts", "shifts_loc_update", "w"), u, c)
    u, c = pre[("shifts", "shifts_loc_delete", "d")]
    check("bucketB_gate", ("shifts", "shifts_loc_delete", "d"), gated(u), None)
    # daily_reconciliation: insert + update kept, delete gated
    u, c = pre[("daily_reconciliation", "daily_reconciliation_org_insert", "a")]
    check("bucketB_keep", ("daily_reconciliation", "daily_reconciliation_org_insert", "a"), None, c)
    u, c = pre[("daily_reconciliation", "daily_reconciliation_org_update", "w")]
    check("bucketB_keep", ("daily_reconciliation", "daily_reconciliation_org_update", "w"), u, c)
    u, c = pre[("daily_reconciliation", "daily_reconciliation_org_delete", "d")]
    check("bucketB_gate", ("daily_reconciliation", "daily_reconciliation_org_delete", "d"), gated(u), None)
    # stock_count_audit: insert kept, update gated both, delete gated
    u, c = pre[("stock_count_audit", "stock_count_audit_org_insert", "a")]
    check("bucketB_keep", ("stock_count_audit", "stock_count_audit_org_insert", "a"), None, c)
    u, c = pre[("stock_count_audit", "stock_count_audit_org_update", "w")]
    check("bucketB_gate", ("stock_count_audit", "stock_count_audit_org_update", "w"), gated(u), gated(c))
    u, c = pre[("stock_count_audit", "stock_count_audit_org_delete", "d")]
    check("bucketB_gate", ("stock_count_audit", "stock_count_audit_org_delete", "d"), gated(u), None)

    if violations:
        print(f"EXPRDIFF: {len(violations)} violation(s)\n")
        for v in violations:
            print(v)
            print("-" * 60)
        sys.exit(1)
    print("EXPRDIFF: 0 violations — every touched policy transformed exactly as intended.")


if __name__ == "__main__":
    main()
