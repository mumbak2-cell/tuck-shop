"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Package,
  Egg,
  ShoppingCart,
  ClipboardList,
  BarChart3,
  Users,
  Menu,
  X,
  TruckIcon,
  Receipt,
  BookOpen,
  FileBarChart,
  Settings,
  LogOut,
  PackagePlus,
  ShieldCheck,
  Clock,
  Wrench,
  Warehouse,
  Send,
  Store,
  Truck,
  ClipboardCheck,
  FileText,
  ArrowRightLeft,
  Percent,
  TrendingUp,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { LocationSwitcher } from "@/components/layout/location-switcher";
import { OfflineIndicator } from "@/components/layout/offline-indicator";
import type { UserRole } from "@/types/database";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  roles: UserRole[];
  foodOnly?: boolean;
  wmsOnly?: boolean;
  retailOnly?: boolean;
  // Collapsible section this item belongs to. Ungrouped items (Dashboard,
  // Settings) stay pinned above/below the groups.
  group?: "shop" | "warehouse";
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "cashier"] },
  { href: "/shift", label: "Shift", icon: Clock, roles: ["admin", "cashier"], retailOnly: true, group: "shop" },
  { href: "/pos", label: "Point of Sale", icon: ShoppingCart, roles: ["admin", "cashier"], retailOnly: true, group: "shop" },
  { href: "/sales", label: "Today's Sales", icon: BarChart3, roles: ["admin", "cashier"], retailOnly: true, group: "shop" },
  { href: "/stock", label: "Stock Count", icon: ClipboardList, roles: ["admin", "cashier"], retailOnly: true, group: "shop" },
  { href: "/receive-stock", label: "Receive Stock", icon: PackagePlus, roles: ["admin"], retailOnly: true, group: "shop" },
  { href: "/suppliers", label: "Suppliers", icon: Truck, roles: ["admin"], group: "shop" },
  { href: "/stock-adjustments", label: "Stock Adjustments", icon: Wrench, roles: ["admin"], retailOnly: true, group: "shop" },
  { href: "/stock-transfers", label: "Stock Transfers", icon: ArrowRightLeft, roles: ["admin"], retailOnly: true, group: "shop" },
  { href: "/products", label: "Products", icon: Package, roles: ["admin"], retailOnly: true, group: "shop" },
  { href: "/ingredients", label: "Ingredients", icon: Egg, roles: ["admin"], foodOnly: true, group: "shop" },
  { href: "/customers", label: "Customers", icon: Users, roles: ["admin"], group: "shop" },
  { href: "/expenses", label: "Expenses", icon: Receipt, roles: ["admin", "cashier"], group: "shop" },
  { href: "/credit-ledger", label: "Credit Ledger", icon: BookOpen, roles: ["admin"], group: "shop" },
  { href: "/reports", label: "Reports", icon: TrendingUp, roles: ["admin", "cashier"], group: "shop" },
  { href: "/profit-loss", label: "Profit & Loss", icon: FileBarChart, roles: ["admin"], group: "shop" },
  { href: "/promotions", label: "Promotions", icon: Percent, roles: ["admin"], retailOnly: true, group: "shop" },
  { href: "/revenue-assurance", label: "Revenue Assurance", icon: ShieldCheck, roles: ["admin"], retailOnly: true, group: "shop" },
  { href: "/stockpilot-import", label: "StockPilot Import", icon: TruckIcon, roles: ["admin"], retailOnly: true, group: "shop" },
  { href: "/locations", label: "Locations", icon: Store, roles: ["admin"], group: "shop" },
  // WMS items
  { href: "/warehouse/dashboard", label: "WMS Dashboard", icon: BarChart3, roles: ["admin"], wmsOnly: true, group: "warehouse" },
  { href: "/warehouse", label: "Warehouse Stock", icon: Warehouse, roles: ["admin"], wmsOnly: true, group: "warehouse" },
  { href: "/warehouse/receive", label: "WMS Receive", icon: PackagePlus, roles: ["admin"], wmsOnly: true, group: "warehouse" },
  { href: "/warehouse/dispatch", label: "WMS Dispatch", icon: Send, roles: ["admin"], wmsOnly: true, group: "warehouse" },
  { href: "/warehouse/adjustments", label: "WMS Adjustments", icon: Wrench, roles: ["admin"], wmsOnly: true, group: "warehouse" },
  { href: "/warehouse/stock-count", label: "WMS Stock Count", icon: ClipboardCheck, roles: ["admin"], wmsOnly: true, group: "warehouse" },
  { href: "/warehouse/purchase-orders", label: "WMS Purchase Orders", icon: FileText, roles: ["admin"], wmsOnly: true, group: "warehouse" },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
];

type NavGroup = "shop" | "warehouse";

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
        active ? "bg-green-50 text-green-700" : "text-gray-700 hover:bg-gray-50"
      }`}
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      {item.label}
    </Link>
  );
}

// Collapsible Shop / Warehouse sections. Mounted with key={activeGroup}, so
// navigating across sections remounts it and re-initialises the open state to
// the section you're now in — entering one area never leaves the other
// expanded. Manual toggles persist while you stay within a section.
function NavSections({
  activeGroup,
  pathname,
  onNavigate,
  pinnedTop,
  pinnedBottom,
  shopItems,
  warehouseItems,
}: {
  activeGroup: NavGroup;
  pathname: string;
  onNavigate: () => void;
  pinnedTop: NavItem[];
  pinnedBottom: NavItem[];
  shopItems: NavItem[];
  warehouseItems: NavItem[];
}) {
  const [expanded, setExpanded] = useState<Record<NavGroup, boolean>>(() => ({
    shop: activeGroup === "shop",
    warehouse: activeGroup === "warehouse",
  }));
  const toggle = (g: NavGroup) => setExpanded((prev) => ({ ...prev, [g]: !prev[g] }));

  const link = (item: NavItem) => (
    <NavLink key={item.href} item={item} active={pathname === item.href} onNavigate={onNavigate} />
  );

  const header = (label: string, group: NavGroup) => (
    <button
      onClick={() => toggle(group)}
      aria-expanded={expanded[group]}
      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600 transition-colors"
    >
      <span>{label}</span>
      {expanded[group] ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
    </button>
  );

  return (
    <>
      {pinnedTop.map(link)}

      <div className="pt-1">
        {header("Shop", "shop")}
        {expanded.shop && <div className="mt-1 space-y-1">{shopItems.map(link)}</div>}
      </div>

      <div className="pt-1">
        {header("Warehouse", "warehouse")}
        {expanded.warehouse && <div className="mt-1 space-y-1">{warehouseItems.map(link)}</div>}
      </div>

      {pinnedBottom.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200 space-y-1">{pinnedBottom.map(link)}</div>
      )}
    </>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { role, name, logout } = useAuth();
  const { preparesFood, wmsEnabled, wmsOnly, orgId } = useOrg();

  const visibleItems = navItems.filter((item) => {
    if (!role || !item.roles.includes(role)) return false;
    if (item.foodOnly && !preparesFood) return false;
    if (item.wmsOnly && !wmsEnabled) return false;
    if (item.retailOnly && wmsOnly) return false;
    return true;
  });

  const activeGroup: NavGroup = pathname.startsWith("/warehouse") ? "warehouse" : "shop";
  const pinnedTop = visibleItems.filter((i) => !i.group && i.href === "/dashboard");
  const pinnedBottom = visibleItems.filter((i) => !i.group && i.href !== "/dashboard");
  const shopItems = visibleItems.filter((i) => i.group === "shop");
  const warehouseItems = visibleItems.filter((i) => i.group === "warehouse");

  return (
    <>
      {/* Mobile menu button */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        className="lg:hidden fixed top-4 left-4 z-40 p-2 bg-white rounded-lg shadow-md"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Overlay */}
      {open && (
        <div className="fixed inset-0 bg-black/30 z-40 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 transform transition-transform lg:translate-x-0 lg:static lg:z-auto flex flex-col ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between h-16 px-6 border-b border-gray-200">
          <h1 className="text-lg font-bold text-green-700">Tilify</h1>
          <button onClick={() => setOpen(false)} aria-label="Close navigation menu" className="lg:hidden p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 pt-4">
          <LocationSwitcher />
        </div>
        <OfflineIndicator orgId={orgId} />

        <nav className="flex-1 overflow-y-auto p-4 space-y-1" aria-label="Main navigation">
          {warehouseItems.length === 0 ? (
            // Warehouse module off: single flat list (unchanged behaviour).
            visibleItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={pathname === item.href}
                onNavigate={() => setOpen(false)}
              />
            ))
          ) : (
            <NavSections
              key={activeGroup}
              activeGroup={activeGroup}
              pathname={pathname}
              onNavigate={() => setOpen(false)}
              pinnedTop={pinnedTop}
              pinnedBottom={pinnedBottom}
              shopItems={shopItems}
              warehouseItems={warehouseItems}
            />
          )}
        </nav>

        {/* User info + logout */}
        <div className="border-t border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">{name}</p>
              <p className="text-xs text-gray-500 capitalize">{role}</p>
            </div>
            <button
              onClick={logout}
              aria-label="Lock screen"
              className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              title="Lock screen"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
