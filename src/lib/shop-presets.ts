// Preset shop types and the categories typically sold in each.
// The operator picks one as a starting point on /setup and then
// adds, edits, or deletes categories before saving. Nothing here
// is enforced - it is just a smart default.

export interface ShopPreset {
  type: string;
  inventoryPrefix: string;
  preparesFood: boolean;
  categories: string[];
}

export const SHOP_PRESETS: ShopPreset[] = [
  {
    type: "Tuck Shop",
    inventoryPrefix: "TS",
    preparesFood: true,
    categories: [
      "Sweets",
      "Snacks",
      "Soft Drinks",
      "Frozen Treats",
      "Hot Food",
      "Sandwiches",
      "Prepared Food",
      "Ingredients",
    ],
  },
  {
    type: "Stationery",
    inventoryPrefix: "STN",
    preparesFood: false,
    categories: [
      "Pens & Pencils",
      "Paper & Pads",
      "Files & Folders",
      "Calculators",
      "Books",
      "Art Supplies",
      "Printing & Ink",
      "Office Supplies",
    ],
  },
  {
    type: "Spaza Shop",
    inventoryPrefix: "SP",
    preparesFood: false,
    categories: [
      "Bread & Bakery",
      "Groceries",
      "Soft Drinks",
      "Sweets",
      "Toiletries",
      "Cleaning Products",
      "Airtime & Data",
      "Frozen Foods",
    ],
  },
  {
    type: "Hardware",
    inventoryPrefix: "HW",
    preparesFood: false,
    categories: [
      "Tools",
      "Paint",
      "Plumbing",
      "Electrical",
      "Building Materials",
      "Fasteners",
      "Adhesives",
      "Safety Gear",
    ],
  },
  {
    type: "Restaurant or Food Outlet",
    inventoryPrefix: "MENU",
    preparesFood: true,
    categories: [
      "Mains",
      "Sides",
      "Drinks",
      "Desserts",
      "Snacks",
      "Ingredients",
    ],
  },
  {
    // Retail wholesale of baking ingredients, decorating supplies and
    // equipment to bakeries and home bakers. Multi-branch model.
    // Examples: Devine Bakes And Accessories (Lusaka), Cake Couture Zambia,
    // Decor Dash Cake Accessories.
    type: "Baking Supplies & Equipment",
    inventoryPrefix: "BS",
    preparesFood: false,
    categories: [
      "Cream & Dairy",
      "Fondant & Icing",
      "Cake Boards",
      "Cake Boxes & Packaging",
      "Decorating Tools & Sprinkles",
      "Baking Ingredients",
      "Cake Tins & Pans",
      "Utensils & Equipment",
      "Food Colouring",
      "Cake Toppers & Decorations",
    ],
  },
  {
    // Own-baked goods. Kept for shops that genuinely bake (cafés,
    // small home bakeries selling direct to consumers).
    type: "Bakery (Own Bakes)",
    inventoryPrefix: "BK",
    preparesFood: true,
    categories: [
      "Bread",
      "Rolls & Buns",
      "Cakes",
      "Cupcakes & Muffins",
      "Pastries & Pies",
      "Cookies & Biscuits",
      "Drinks",
    ],
  },
  {
    type: "General Retail",
    inventoryPrefix: "ITEM",
    preparesFood: false,
    categories: ["General"],
  },
  {
    type: "Other",
    inventoryPrefix: "ITEM",
    preparesFood: false,
    categories: [],
  },
];
