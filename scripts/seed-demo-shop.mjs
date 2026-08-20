#!/usr/bin/env node
//
// Populate a demo shop with realistic grocery data for video recording.
//
//   Dry run:
//     node --env-file=.env.local scripts/seed-demo-shop.mjs --org "My Test Shop"
//
//   Apply:
//     node --env-file=.env.local scripts/seed-demo-shop.mjs --org "My Test Shop" --apply
//
// Seeds: 2 locations, 1 supplier, ~25 products with stock, 3 credit customers,
// a few days of expenses. Sales must be made through the app (submit_sale_batch
// requires auth context).

import { createServiceClient, resolveOrg, flag as getFlag, runMain } from "./lib/common.mjs";

const args = process.argv.slice(2);
const flag = (name) => getFlag(args, name);
const orgName = flag("org");
const apply = args.includes("--apply");

if (!orgName) {
  console.error('Usage: --org "<shop>" [--apply]');
  process.exit(1);
}

const supabase = createServiceClient();

// ── helpers ──

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── data ──

const CATEGORIES = ["Groceries", "Beverages", "Snacks", "Household", "Dairy & Fresh"];

const PRODUCTS = [
  // Groceries
  { id: "GR001", name: "White Bread (700g)", cat: "Groceries", cost: 12, price: 18, stock: 45 },
  { id: "GR002", name: "Mealie Meal 10kg", cat: "Groceries", cost: 85, price: 120, stock: 30 },
  { id: "GR003", name: "Sunflower Cooking Oil 2L", cat: "Groceries", cost: 55, price: 79, stock: 20 },
  { id: "GR004", name: "White Sugar 2.5kg", cat: "Groceries", cost: 38, price: 52, stock: 35 },
  { id: "GR005", name: "Long Grain Rice 2kg", cat: "Groceries", cost: 30, price: 45, stock: 25 },
  { id: "GR006", name: "Tastic Rice 1kg", cat: "Groceries", cost: 22, price: 35, stock: 18 },
  { id: "GR007", name: "Tin Fish Pilchards 400g", cat: "Groceries", cost: 18, price: 28, stock: 40 },
  { id: "GR008", name: "Baked Beans 410g", cat: "Groceries", cost: 12, price: 19, stock: 38 },
  // Beverages
  { id: "BV001", name: "Coca-Cola 500ml", cat: "Beverages", cost: 10, price: 16, stock: 60 },
  { id: "BV002", name: "Fanta Orange 500ml", cat: "Beverages", cost: 10, price: 16, stock: 48 },
  { id: "BV003", name: "Still Water 500ml", cat: "Beverages", cost: 5, price: 10, stock: 72 },
  { id: "BV004", name: "Oros Squash 2L", cat: "Beverages", cost: 32, price: 48, stock: 15 },
  { id: "BV005", name: "Milk 1L Full Cream", cat: "Beverages", cost: 18, price: 26, stock: 4 },
  // Snacks
  { id: "SN001", name: "Simba Chips Original 125g", cat: "Snacks", cost: 14, price: 22, stock: 36 },
  { id: "SN002", name: "NikNaks Cheese 50g", cat: "Snacks", cost: 6, price: 10, stock: 50 },
  { id: "SN003", name: "Bakers Lemon Creams 200g", cat: "Snacks", cost: 16, price: 25, stock: 24 },
  { id: "SN004", name: "Cadbury Dairy Milk 80g", cat: "Snacks", cost: 20, price: 32, stock: 3 },
  { id: "SN005", name: "Popcorn Caramel 100g", cat: "Snacks", cost: 8, price: 15, stock: 28 },
  // Household
  { id: "HH001", name: "Boom Washing Powder 2kg", cat: "Household", cost: 45, price: 65, stock: 18 },
  { id: "HH002", name: "Sunlight Dishwashing Liquid 750ml", cat: "Household", cost: 28, price: 42, stock: 22 },
  { id: "HH003", name: "Toilet Paper 9-pack", cat: "Household", cost: 55, price: 79, stock: 12 },
  { id: "HH004", name: "Candles (6-pack)", cat: "Household", cost: 15, price: 25, stock: 5 },
  // Dairy & Fresh
  { id: "DF001", name: "Eggs (30 tray)", cat: "Dairy & Fresh", cost: 65, price: 95, stock: 10 },
  { id: "DF002", name: "Butter 500g", cat: "Dairy & Fresh", cost: 45, price: 65, stock: 8 },
  { id: "DF003", name: "Polony 1kg", cat: "Dairy & Fresh", cost: 35, price: 52, stock: 15 },
];

const SUPPLIERS = [
  { name: "Metro Cash & Carry", phone: "0211234567", email: "orders@metro.co.zm" },
];

const CUSTOMERS = [
  { name: "Grace Banda", phone: "0977112233", limit: 2000 },
  { name: "Joseph Mwanza", phone: "0966445566", limit: 1500 },
  { name: "Mary Phiri", phone: "0955778899", limit: 1000 },
];

const EXPENSES = [
  { desc: "Monthly rent - August", amount: 3500, cat: "Rent", days_ago: 15 },
  { desc: "ZESCO electricity bill", amount: 850, cat: "Electricity", days_ago: 10 },
  { desc: "Delivery transport from Metro", amount: 250, cat: "Transport", days_ago: 7 },
  { desc: "Cleaning supplies", amount: 180, cat: "Consumables", days_ago: 5 },
  { desc: "Minibus for stock pickup", amount: 150, cat: "Transport", days_ago: 3 },
  { desc: "Fuel for delivery van", amount: 350, cat: "Fuel", days_ago: 2 },
];

// ── main ──

runMain(async () => {
  const org = await resolveOrg(supabase, orgName);
  console.log(`Shop: ${org.name} (${org.id})`);

  // 1. Check existing locations
  const { data: existingLocs } = await supabase
    .from("locations")
    .select("id, name")
    .eq("org_id", org.id);

  const locations = existingLocs || [];
  console.log(`\nLocations: ${locations.length} existing`);
  locations.forEach(l => console.log(`  - ${l.name} (${l.id})`));

  // We need at least 2 locations
  const locsToCreate = [];
  if (locations.length === 0) {
    locsToCreate.push({ name: "Main Branch", org_id: org.id, active: true, sort_order: 0 });
    locsToCreate.push({ name: "Market Branch", org_id: org.id, active: true, sort_order: 1 });
  } else if (locations.length === 1) {
    locsToCreate.push({ name: "Market Branch", org_id: org.id, active: true, sort_order: 1 });
  }

  if (locsToCreate.length > 0) {
    console.log(`\nWill create ${locsToCreate.length} location(s): ${locsToCreate.map(l => l.name).join(", ")}`);
    if (apply) {
      const { data, error } = await supabase.from("locations").insert(locsToCreate).select("id, name");
      if (error) throw new Error(`locations insert: ${error.message}`);
      locations.push(...data);
      console.log("  Created.");
    }
  }

  if (!apply && locations.length < 2) {
    console.log("  (dry run — would create locations)");
    // Use placeholder IDs for dry run
    locsToCreate.forEach((l, i) => locations.push({ id: `placeholder-${i}`, name: l.name }));
  }

  const mainBranch = locations[0];
  const secondBranch = locations[1];
  console.log(`\nMain branch: ${mainBranch.name} (${mainBranch.id})`);
  if (secondBranch) console.log(`Second branch: ${secondBranch.name} (${secondBranch.id})`);

  // 2. Check existing products
  const { data: existingProducts } = await supabase
    .from("products")
    .select("id, name")
    .eq("org_id", org.id);

  console.log(`\nExisting products: ${(existingProducts || []).length}`);

  if ((existingProducts || []).length >= 15) {
    console.log("  Already has enough products — skipping product seed.");
  } else {
    const productRows = PRODUCTS.map(p => ({
      org_id: org.id,
      inventory_id: p.id,
      name: p.name,
      category: p.cat,
      package_price: p.cost,
      qty_in_pack: 1,
      selling_price: p.price,
      opening_stock: p.stock,
      reorder_level: p.stock <= 5 ? p.stock : 5,
      is_prepared: false,
    }));

    console.log(`\nWill insert ${productRows.length} products:`);
    productRows.forEach(p => console.log(`  ${p.inventory_id}  ${p.name}  cost:${p.package_price}  sell:${p.selling_price}  stock:${p.opening_stock}`));

    if (apply) {
      const { data: inserted, error } = await supabase
        .from("products")
        .insert(productRows)
        .select("id, inventory_id, name");
      if (error) throw new Error(`products insert: ${error.message}`);
      console.log(`  Inserted ${inserted.length} products.`);

      // 2b. Seed product_stock for both branches
      const stockRows = [];
      for (const prod of inserted) {
        const match = PRODUCTS.find(p => p.id === prod.inventory_id);
        if (!match) continue;
        // Main branch gets full stock
        stockRows.push({
          product_id: prod.id,
          location_id: mainBranch.id,
          org_id: org.id,
          quantity: match.stock,
        });
        // Second branch gets ~60% of stock
        if (secondBranch) {
          stockRows.push({
            product_id: prod.id,
            location_id: secondBranch.id,
            org_id: org.id,
            quantity: Math.round(match.stock * 0.6),
          });
        }
      }

      console.log(`\nSeeding stock: ${stockRows.length} rows across ${secondBranch ? 2 : 1} branch(es)...`);
      // Batch in groups of 100
      for (let i = 0; i < stockRows.length; i += 100) {
        const batch = stockRows.slice(i, i + 100);
        const { error: stockErr } = await supabase.from("product_stock").upsert(batch, {
          onConflict: "product_id,location_id",
        });
        if (stockErr) throw new Error(`product_stock upsert: ${stockErr.message}`);
      }
      console.log("  Stock seeded.");
    }
  }

  // 3. Suppliers
  const { data: existingSuppliers } = await supabase
    .from("suppliers")
    .select("id, name")
    .eq("org_id", org.id);

  if ((existingSuppliers || []).length === 0) {
    console.log(`\nWill create ${SUPPLIERS.length} supplier(s): ${SUPPLIERS.map(s => s.name).join(", ")}`);
    if (apply) {
      const supplierRows = SUPPLIERS.map(s => ({
        org_id: org.id,
        name: s.name,
        phone: s.phone,
        email: s.email,
        active: true,
      }));
      const { error } = await supabase.from("suppliers").insert(supplierRows);
      if (error) throw new Error(`suppliers insert: ${error.message}`);
      console.log("  Created.");
    }
  } else {
    console.log(`\nSuppliers: ${existingSuppliers.length} existing — skipping.`);
  }

  // 4. Credit customers
  const { data: existingCustomers } = await supabase
    .from("customers")
    .select("id, name")
    .eq("org_id", org.id);

  if ((existingCustomers || []).length === 0) {
    console.log(`\nWill create ${CUSTOMERS.length} customer(s): ${CUSTOMERS.map(c => c.name).join(", ")}`);
    if (apply) {
      const custRows = CUSTOMERS.map(c => ({
        org_id: org.id,
        name: c.name,
        phone: c.phone,
        credit_limit: c.limit,
        balance: 0,
      }));
      const { error } = await supabase.from("customers").insert(custRows);
      if (error) throw new Error(`customers insert: ${error.message}`);
      console.log("  Created.");
    }
  } else {
    console.log(`\nCustomers: ${existingCustomers.length} existing — skipping.`);
  }

  // 5. Expenses (spread over past 2 weeks)
  const { data: existingExpenses } = await supabase
    .from("expenses")
    .select("id")
    .eq("org_id", org.id)
    .limit(1);

  if ((existingExpenses || []).length === 0) {
    console.log(`\nWill create ${EXPENSES.length} expenses:`);
    EXPENSES.forEach(e => console.log(`  ${daysAgo(e.days_ago)}  ${e.cat}: ${e.desc}  R${e.amount}`));

    if (apply) {
      const expenseRows = EXPENSES.map(e => ({
        org_id: org.id,
        description: e.desc,
        amount: e.amount,
        category: e.cat,
        expense_date: daysAgo(e.days_ago),
      }));
      const { error } = await supabase.from("expenses").insert(expenseRows);
      if (error) throw new Error(`expenses insert: ${error.message}`);
      console.log("  Created.");
    }
  } else {
    console.log(`\nExpenses: already exist — skipping.`);
  }

  // 6. Summary
  console.log("\n══════════════════════════════════════════");
  if (apply) {
    console.log("DONE — demo shop seeded.");
    console.log("\nNext steps (do in the app):");
  } else {
    console.log("DRY RUN — nothing written. Add --apply to execute.");
    console.log("\nAfter applying, do in the app:");
  }
  console.log("  1. Open a shift and make 8-10 sales across both branches");
  console.log("  2. Make 1-2 credit sales to Grace Banda and Joseph Mwanza");
  console.log("  3. Record a stock delivery via Receive Stock");
  console.log("  4. Do a partial stock count");
  console.log("  These give you sales history for Dashboard/Reports in the video.");
});
