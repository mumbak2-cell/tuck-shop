"use client";
import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import type { UserRole } from "@/types/database";

/** Compare a typed PIN against a branch's shared admin/cashier PINs.
 *  Goes through the match_location_pin() SECURITY DEFINER RPC rather than a
 *  direct table query — the admin_pin / cashier_pin rows in location_settings
 *  are not readable by a cashier-role account (migration 100), precisely so a
 *  signed-in cashier can't read the branch admin PIN straight off the table.
 *  The RPC re-checks org membership and never returns the stored value, only
 *  which role matched ('admin' | 'cashier'), or null. */
async function matchLocationPin(
  locationId: string | null,
  pin: string
): Promise<"admin" | "cashier" | null> {
  if (!locationId) return null;
  const { data } = await db.rpc("match_location_pin", {
    p_location_id: locationId,
    p_pin: pin,
  });
  return data === "admin" || data === "cashier" ? data : null;
}

/** Per-user PIN lookup, scoped to one org. Goes through the
 *  match_member_pin() SECURITY DEFINER RPC rather than a direct table
 *  query — org_members.pin is not readable by the authenticated role
 *  at the column level (migration 097), precisely so a signed-in
 *  cashier can't read teammates' PINs straight off the table. The RPC
 *  re-checks that the caller actually belongs to orgId before it will
 *  match anything. */
async function fetchMemberByPin(
  orgId: string | null,
  pin: string
): Promise<{ id: string; role: string; displayName: string | null } | null> {
  if (!orgId) return null;
  const { data } = await db.rpc("match_member_pin", { p_org_id: orgId, p_pin: pin });
  const row = (data as { id: string; role: string; display_name: string | null }[] | null)?.[0];
  if (!row) return null;
  return { id: row.id, role: row.role, displayName: row.display_name };
}

interface AuthState {
  role: UserRole | null;
  name: string;
  memberId: string | null;
  authenticated: boolean;
  login: (pin: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  role: null,
  name: "",
  memberId: null,
  authenticated: false,
  login: async () => false,
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { currentLocationId, orgId } = useOrg();
  const [role, setRole] = useState<UserRole | null>(null);
  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);

  // Check session storage for existing login
  useEffect(() => {
    const saved = sessionStorage.getItem("tilify_auth") || sessionStorage.getItem("tuckshop_auth");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.role && parsed.name) {
          setRole(parsed.role);
          setName(parsed.name);
          setMemberId(parsed.memberId || null);
          setAuthenticated(true);
        }
      } catch {
        // ignore
      }
    }
  }, []);

  async function login(pin: string): Promise<boolean> {
    // Priority 1: per-user PIN match against org_members.
    const member = await fetchMemberByPin(orgId, pin);
    if (member) {
      const authRole: UserRole = member.role === "member" ? "cashier" : "admin";
      const displayName = member.displayName || (member.role === "member" ? "Cashier" : "Admin");
      setRole(authRole);
      setName(displayName);
      setMemberId(member.id);
      setAuthenticated(true);
      sessionStorage.setItem(
        "tilify_auth",
        JSON.stringify({ role: authRole, name: displayName, memberId: member.id })
      );
      return true;
    }

    // Priority 2: shared location PINs (backward compat). The compare runs
    // server-side (match_location_pin) so the PIN values never reach a
    // not-yet-authenticated client.
    const matched = await matchLocationPin(currentLocationId, pin);
    if (matched === "admin") {
      setRole("admin");
      setName("Admin");
      setMemberId(null);
      setAuthenticated(true);
      sessionStorage.setItem("tilify_auth", JSON.stringify({ role: "admin", name: "Admin" }));
      return true;
    }
    if (matched === "cashier") {
      setRole("cashier");
      setName("Cashier");
      setMemberId(null);
      setAuthenticated(true);
      sessionStorage.setItem("tilify_auth", JSON.stringify({ role: "cashier", name: "Cashier" }));
      return true;
    }
    return false;
  }

  function logout() {
    setRole(null);
    setName("");
    setMemberId(null);
    setAuthenticated(false);
    sessionStorage.removeItem("tilify_auth");
    sessionStorage.removeItem("tuckshop_auth");
  }

  return (
    <AuthContext.Provider value={{ role, name, memberId, authenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
