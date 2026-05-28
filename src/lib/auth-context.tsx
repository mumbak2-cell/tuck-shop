"use client";
import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { db } from "@/lib/supabase";
import type { UserRole } from "@/types/database";

interface AuthState {
  role: UserRole | null;
  name: string;
  authenticated: boolean;
  login: (pin: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  role: null,
  name: "",
  authenticated: false,
  login: async () => false,
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<UserRole | null>(null);
  const [name, setName] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [pins, setPins] = useState<{ admin: string; cashier: string }>({
    admin: "1234",
    cashier: "0000",
  });

  // Load PINs from settings
  useEffect(() => {
    db
      .from("app_settings")
      .select("key, value")
      .in("key", ["admin_pin", "cashier_pin"])
      .then(({ data }: { data: { key: string; value: string }[] | null }) => {
        if (data) {
          const map: Record<string, string> = {};
          data.forEach((row: { key: string; value: string }) => (map[row.key] = row.value));
          setPins({
            admin: map.admin_pin || "1234",
            cashier: map.cashier_pin || "0000",
          });
        }
      });
  }, []);

  // Check session storage for existing login
  useEffect(() => {
    const saved = sessionStorage.getItem("tuckshop_auth");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.role && parsed.name) {
          setRole(parsed.role);
          setName(parsed.name);
          setAuthenticated(true);
        }
      } catch {
        // ignore
      }
    }
  }, []);

  async function login(pin: string): Promise<boolean> {
    // Refresh PINs from DB in case they changed
    const { data } = await db
      .from("app_settings")
      .select("key, value")
      .in("key", ["admin_pin", "cashier_pin"]);

    const currentPins = { ...pins };
    if (data) {
      (data as any[]).forEach((row: any) => {
        if (row.key === "admin_pin") currentPins.admin = row.value;
        if (row.key === "cashier_pin") currentPins.cashier = row.value;
      });
      setPins(currentPins);
    }

    if (pin === currentPins.admin) {
      setRole("admin");
      setName("Admin");
      setAuthenticated(true);
      sessionStorage.setItem("tuckshop_auth", JSON.stringify({ role: "admin", name: "Admin" }));
      return true;
    }
    if (pin === currentPins.cashier) {
      setRole("cashier");
      setName("Cashier");
      setAuthenticated(true);
      sessionStorage.setItem("tuckshop_auth", JSON.stringify({ role: "cashier", name: "Cashier" }));
      return true;
    }
    return false;
  }

  function logout() {
    setRole(null);
    setName("");
    setAuthenticated(false);
    sessionStorage.removeItem("tuckshop_auth");
  }

  return (
    <AuthContext.Provider value={{ role, name, authenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
