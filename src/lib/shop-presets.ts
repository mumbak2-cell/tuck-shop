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
    // Mix of own-baked goods and retail baking accessories.
    // Examples: Chichi's Bakes & Accessories (Lusaka), Cake Couture Zambia.
    type: "Bakery & Accessories",
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
      "Cake Boards & Boxes",
      "Decorating Tools",
      "Sprinkles & Toppers",
      "Icing & Fondant",
      "Baking Ingredients",
      "Cake Tins & Pans",
      "Food Colouring",
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
