"use client";
import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import type { UserRole } from "@/types/database";

/** Load the admin/cashier PINs for one location from location_settings.
 *  PINs are per-location (migration 0230): each branch has its own admin and
 *  cashier PIN. A role with no PIN row set returns null for that role, so
 *  login refuses it rather than falling back to a guessable default. Returns
 *  null only when there is no location to scope to. */
async function fetchPinsForLocation(
  locationId: string | null
): Promise<{ admin: string | null; cashier: string | null } | null> {
  if (!locationId) return null;
  const { data } = await db
    .from("location_settings")
    .select("key, value")
    .eq("location_id", locationId)
    .in("key", ["admin_pin", "cashier_pin"]);
  const map: Record<string, string> = {};
  ((data || []) as { key: string; value: string }[]).forEach((row) => (map[row.key] = row.value));
  return {
    admin: map.admin_pin || null,
    cashier: map.cashier_pin || null,
  };
}

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
  const { currentLocationId } = useOrg();
  const [role, setRole] = useState<UserRole | null>(null);
  const [name, setName] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [pins, setPins] = useState<{ admin: string | null; cashier: string | null }>({
    admin: null,
    cashier: null,
  });

  // Load PINs for the active location. PINs live in location_settings, keyed
  // per branch, so they reload whenever the operator switches location.
  useEffect(() => {
    let cancelled = false;
    fetchPinsForLocation(currentLocationId).then((p) => {
      if (p && !cancelled) setPins(p);
    });
    return () => {
      cancelled = true;
    };
  }, [currentLocationId]);

  // Check session storage for existing login
  useEffect(() => {
    const saved = sessionStorage.getItem("tilify_auth") || sessionStorage.getItem("tuckshop_auth");
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
    // Refresh the active location's PINs from the DB in case they changed.
    const fresh = await fetchPinsForLocation(currentLocationId);
    const currentPins = fresh ?? pins;
    if (fresh) setPins(fresh);

    if (pin === currentPins.admin) {
      setRole("admin");
      setName("Admin");
      setAuthenticated(true);
      sessionStorage.setItem("tilify_auth", JSON.stringify({ role: "admin", name: "Admin" }));
      return true;
    }
    if (pin === currentPins.cashier) {
      setRole("cashier");
      setName("Cashier");
      setAuthenticated(true);
      sessionStorage.setItem("tilify_auth", JSON.stringify({ role: "cashier", name: "Cashier" }));
      return true;
    }
    return false;
  }

  function logout() {
    setRole(null);
    setName("");
    setAuthenticated(false);
    sessionStorage.removeItem("tilify_auth");
    sessionStorage.removeItem("tuckshop_auth");
  }

  return (
    <AuthContext.Provider value={{ role, name, authenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
