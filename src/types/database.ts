export type Database = {
  public: {
    Tables: {
      products: {
        Row: Product;
        Insert: Omit<Product, "id" | "cost_per_unit" | "created_at">;
        Update: Partial<Omit<Product, "id" | "cost_per_unit" | "created_at">>;
      };
      ingredients: {
        Row: Ingredient;
        Insert: Omit<Ingredient, "id" | "created_at">;
        Update: Partial<Omit<Ingredient, "id" | "created_at">>;
      };
      recipes: {
        Row: Recipe;
        Insert: Omit<Recipe, "id">;
        Update: Partial<Omit<Recipe, "id">>;
      };
      sales: {
        Row: Sale;
        Insert: Omit<Sale, "id" | "created_at">;
        Update: Partial<Omit<Sale, "id" | "created_at">>;
      };
      stock_counts: {
        Row: StockCount;
        Insert: Omit<StockCount, "id" | "units_sold_calc">;
        Update: Partial<Omit<StockCount, "id" | "units_sold_calc">>;
      };
      production_log: {
        Row: ProductionEntry;
        Insert: Omit<ProductionEntry, "id" | "created_at">;
        Update: Partial<Omit<ProductionEntry, "id" | "created_at">>;
      };
      customers: {
        Row: Customer;
        Insert: Omit<Customer, "id" | "created_at">;
        Update: Partial<Omit<Customer, "id" | "created_at">>;
      };
      customer_payments: {
        Row: CustomerPayment;
        Insert: Omit<CustomerPayment, "id" | "created_at">;
        Update: Partial<Omit<CustomerPayment, "id" | "created_at">>;
      };
      daily_reconciliation: {
        Row: DailyReconciliation;
        Insert: Omit<DailyReconciliation, "id" | "created_at">;
        Update: Partial<Omit<DailyReconciliation, "id" | "created_at">>;
      };
      purchases: {
        Row: Purchase;
        Insert: Omit<Purchase, "id" | "created_at">;
        Update: Partial<Omit<Purchase, "id" | "created_at">>;
      };
      expenses: {
        Row: Expense;
        Insert: Omit<Expense, "id" | "created_at">;
        Update: Partial<Omit<Expense, "id" | "created_at">>;
      };
      app_settings: {
        Row: AppSetting;
        Insert: AppSetting;
        Update: Partial<AppSetting>;
      };
      stock_receipts: {
        Row: StockReceipt;
        Insert: Omit<StockReceipt, "id" | "created_at">;
        Update: Partial<Omit<StockReceipt, "id" | "created_at">>;
      };
      stock_receipt_items: {
        Row: StockReceiptItem;
        Insert: Omit<StockReceiptItem, "id" | "line_total">;
        Update: Partial<Omit<StockReceiptItem, "id" | "line_total">>;
      };
    };
  };
};

export interface Product {
  id: string;
  inventory_id: string;
  name: string;
  category: string;
  package_price: number | null;
  qty_in_pack: number | null;
  cost_per_unit: number | null;
  // Prepared items: how many units one batch of the recipe yields, and the
  // resulting per-unit cost. recipe_cost_per_unit is maintained by a database
  // trigger (migration 055) — never write it from the app.
  units_per_batch: number | null;
  recipe_cost_per_unit: number | null;
  selling_price: number;
  is_prepared: boolean;
  opening_stock: number;
  reorder_level: number;
  discontinued: boolean;
  created_at: string;
}

export interface Ingredient {
  id: string;
  name: string;
  unit: string;
  purchase_size: string | null;
  purchase_price: number;
  // How many `unit`s purchase_price buys — R50 for a 2.5kg bag with unit=kg
  // is 2.5. NULL means recipes using this ingredient cannot be costed.
  purchase_qty: number | null;
  current_stock: number;
  reorder_level: number;
  created_at: string;
}

export interface Recipe {
  id: string;
  product_id: string;
  ingredient_id: string;
  quantity_per_batch: number;
  unit: string;
}

export interface Sale {
  id: string;
  sale_date: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  payment_method: "cash" | "card" | "credit";
  customer_id: string | null;
  created_at: string;
}

export interface StockCount {
  id: string;
  count_date: string;
  product_id: string;
  opening_units: number;
  closing_units: number;
  replenished_units: number;
  units_sold_calc: number;
}

export interface ProductionEntry {
  id: string;
  production_date: string;
  product_id: string;
  batches_made: number;
  units_produced: number;
  batch_cost: number | null;
  created_at: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  credit_limit: number;
  balance: number;
  created_at: string;
}

export interface CustomerPayment {
  id: string;
  customer_id: string;
  payment_date: string;
  amount: number;
  created_at: string;
}

export interface DailyReconciliation {
  id: string;
  recon_date: string;
  opening_float: number | null;
  cash_sales: number | null;
  card_sales: number | null;
  credit_sales: number | null;
  expected_cash: number | null;
  actual_cash: number | null;
  variance: number | null;
  created_at: string;
}

export interface Purchase {
  id: string;
  purchase_date: string;
  ingredient_id: string | null;
  product_id: string | null;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  supplier: string | null;
  created_at: string;
}

export interface Expense {
  id: string;
  expense_date: string;
  category: ExpenseCategory;
  description: string | null;
  amount: number;
  director_name: string | null;
  recorded_by: string | null;
  created_at: string;
}

export const EXPENSE_CATEGORIES = [
  "Transport",
  "Fuel",
  "Rent",
  "Electricity",
  "Consumables",
  "Wages",
  "Stock Purchases",
  "Director Withdrawal",
  "Other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface AppSetting {
  key: string;
  value: string;
  updated_at?: string;
}

export interface StockReceipt {
  id: string;
  receipt_date: string;
  supplier: string | null;
  notes: string | null;
  total_cost: number;
  recorded_by: string | null;
  created_at: string;
}

export interface StockReceiptItem {
  id: string;
  receipt_id: string;
  product_id: string | null;
  ingredient_id: string | null;
  quantity: number;
  unit_cost: number;
  line_total: number;
}

export type UserRole = "admin" | "cashier";

export const CATEGORIES = [
  "Sweets",
  "Snacks",
  "Soft Drinks",
  "Frozen Treats",
  "Hot Food",
  "Sandwiches",
  "Prepared Food",
  "Ingredients",
] as const;

export type Category = (typeof CATEGORIES)[number];
