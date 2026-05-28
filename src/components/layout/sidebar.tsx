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
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import type { UserRole } from "@/types/database";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  roles: UserRole[];
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "cashier"] },
  { href: "/pos", label: "Point of Sale", icon: ShoppingCart, roles: ["admin", "cashier"] },
  { href: "/sales", label: "Today's Sales", icon: BarChart3, roles: ["admin", "cashier"] },
  { href: "/stock", label: "Stock Count", icon: ClipboardList, roles: ["admin", "cashier"] },
  { href: "/receive-stock", label: "Receive Stock", icon: PackagePlus, roles: ["admin"] },
  { href: "/products", label: "Products", icon: Package, roles: ["admin"] },
  { href: "/ingredients", label: "Ingredients", icon: Egg, roles: ["admin"] },
  { href: "/customers", label: "Customers", icon: Users, roles: ["admin"] },
  { href: "/expenses", label: "Expenses", icon: Receipt, roles: ["admin"] },
  { href: "/credit-ledger", label: "Credit Ledger", icon: BookOpen, roles: ["admin"] },
  { href: "/profit-loss", label: "Profit & Loss", icon: FileBarChart, roles: ["admin"] },
  { href: "/stockpilot-import", label: "StockPilot Import", icon: TruckIcon, roles: ["admin"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { role, name, logout } = useAuth();

  const visibleItems = navItems.filter((item) => role && item.roles.includes(role));

  return (
    <>
      {/* Mobile menu button */}
      <button
        onClick={() => setOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-40 p-2 bg-white rounded-lg shadow-md"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Overlay */}
      {open && (
        <div className="fixed inset-0 bg-black/30 z-40 lg:hidden" onClick={() => setOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 transform transition-transform lg:translate-x-0 lg:static lg:z-auto flex flex-col ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between h-16 px-6 border-b border-gray-200">
          <h1 className="text-lg font-bold text-green-700">Tuck Shop</h1>
          <button onClick={() => setOpen(false)} className="lg:hidden p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? "bg-green-50 text-green-700"
                    : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                {item.label}
              </Link>
            );
          })}
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
