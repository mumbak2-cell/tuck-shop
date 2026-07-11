# Setting Different Prices per Branch — Tilify Guide

*Customer-facing how-to (e.g. for Chichi's Bakes and Accessories). A printable
PDF can be generated from this content; keep the two in sync when editing.*

As you open more branches, some items may sell for a different price at each one.
Tilify lets you keep **one main price** for a product and set a **different price
at a specific branch** only where you need to — you never have to re-enter prices
for every item at every branch, just the exceptions.

## How it works, in one line

Every product has a **base price** that applies everywhere. If you set a price for a
particular branch, that branch uses it instead. If you leave a branch blank, it simply
charges the base price.

*(Under the hood: `products.selling_price` is the base; `product_location_prices` holds
per-`(product, location)` overrides. Effective price = override for the current location,
else base. See `CLAUDE.md`.)*

## Add a new branch (one-time setup)

1. In the left menu, tap **Locations**.
2. Tap **Add Location** (top-right).
3. Type the branch **name** (address is optional), then **Save**.

Do this once for each branch. The *Prices per branch* option below only appears once you
have more than one branch. (The **Locations** menu is visible when signed in with the
**Admin PIN**.)

## Before you start (for each product)

1. **Your branches are added** under **Locations** (see above).
2. **Stock is at each branch** — a product only shows on the till at a branch where it has
   stock. Use **Receive Stock** to stock each branch.
3. **A base price is set** on the product (the normal *Selling Price*).

## Set a different price for a branch

1. In the left menu, tap **Products**.
2. Search for the product (e.g. type *Chocolate Cake*) and tap **Edit**.
3. Scroll to the section titled **"Prices per branch (optional)."** You'll see a box for
   each of your branches.
4. In the box for the branch that charges differently, type that branch's price.
   *Leave the other branches blank — blank means "use the base price."*
5. Tap **Save Changes**.

> **Example:** Chocolate Cake's base price is **R80**. At your Town branch it sells for
> **R90**. Put **90** in the *Town* box and leave the other branches blank. Everywhere
> else it stays R80; at Town it rings up R90.

## Change or remove a branch price

1. Open the product → **Edit** → **Prices per branch**.
2. To **change** it, type the new number in that branch's box.
3. To go **back to the base price**, clear the box (delete the number) and leave it empty.
4. Tap **Save Changes**.

## When you sell (the till)

- Pick the branch you're selling from using the **branch selector at the top-left** of the
  screen.
- On the **Point of Sale** screen, each item shows **that branch's price** automatically —
  the branch price where you set one, the base price everywhere else.
- The price on the receipt and in your reports is always the price actually charged, so
  your sales figures per branch stay correct.

## Good to know

- **Only set the exceptions.** Most items are the same price everywhere — leave those
  branches blank and they follow the base price.
- **Changing the base price** later still updates every branch that doesn't have its own
  price set.
- **An item not showing at a branch?** That branch has no stock of it — receive stock there
  first.

---

*Tilify by MK Global SA — Business Performance Improvement Company*
