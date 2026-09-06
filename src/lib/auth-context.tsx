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
export async function matchLocationPin(
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

/** Seconds remaining on the caller's own till-PIN lockout, or null when not
 *  locked (or on any error — a failed status lookup must never block or alter
 *  the login path). Backed by till_pin_lockout_seconds() (migration 112); the
 *  throttle itself (migration 110) still returns a wrong-PIN-indistinguishable
 *  result, this is the one place the lockout is surfaced. */
export async function tillPinLockoutSeconds(): Promise<number | null> {
  try {
    const { data, error } = await db.rpc("till_pin_lockout_seconds");
    if (error || typeof data !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

interface AuthState {
  role: UserRole | null;
  name: string;
  memberId: string | null;
  authenticated: boolean;
  loading: boolean;
  login: (pin: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  role: null,
  name: "",
  memberId: null,
  authenticated: false,
  loading: true,
  login: async () => false,
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { currentLocationId, orgId, loading: orgLoading } = useOrg();
  const [role, setRole] = useState<UserRole | null>(null);
  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  // Resolve any stored token against the server on mount — the client no
  // longer trusts a cached {role,name} blob (that was forgeable via
  // devtools; see migration 109 / .agents/briefs/till-session-token.md).
  // `loading` stays true for the duration of this round-trip so consumers
  // can avoid flashing the PIN pad while it's in flight.
  //
  // Gated on org.loading: supabase-js restores the persisted Supabase
  // session from localStorage asynchronously. If resume_till_session went
  // out before that lands, it would carry the anon key, auth.uid() would
  // be NULL server-side, and the function's own membership check would
  // correctly return no rows for a perfectly valid token — indistinguishable,
  // from here, from an actually-bad token. Waiting for org.loading to
  // clear means the RPC always carries a hydrated session when one exists.
  useEffect(() => {
    if (orgLoading) return;
    let cancelled = false;

    async function resume() {
      const token = sessionStorage.getItem("tilify_auth");
      if (!token) {
        setLoading(false);
        return;
      }
      const { data, error } = await db.rpc("resume_till_session", { p_token: token });
      if (cancelled) return;
      if (error) {
        // Inconclusive, not "invalid" — leave the token and auth state
        // alone rather than treat a transient/auth error as a bad token.
        // The next mount (or effect re-run) gets a clean retry.
        setLoading(false);
        return;
      }
      const row = (data as { role: string; display_name: string | null; member_id: string | null }[] | null)?.[0];
      if (row) {
        setRole(row.role as UserRole);
        setName(row.display_name || (row.role === "admin" ? "Admin" : "Cashier"));
        setMemberId(row.member_id);
        setAuthenticated(true);
      } else {
        // A real, definitive "no such session" from the server — only
        // now is it safe to drop the token.
        sessionStorage.removeItem("tilify_auth");
        setAuthenticated(false);
      }
      setLoading(false);
    }

    void resume();
    return () => {
      cancelled = true;
    };
  }, [orgLoading]);

  async function login(pin: string): Promise<boolean> {
    if (!orgId) return false;
    const { data } = await db.rpc("create_till_session", {
      p_org_id: orgId,
      p_location_id: currentLocationId,
      p_pin: pin,
    });
    const row = (data as
      | { token: string; role: string; display_name: string | null; member_id: string | null }[]
      | null)?.[0];
    if (!row) return false;
    setRole(row.role as UserRole);
    setName(row.display_name || (row.role === "admin" ? "Admin" : "Cashier"));
    setMemberId(row.member_id);
    setAuthenticated(true);
    sessionStorage.setItem("tilify_auth", row.token);
    return true;
  }

  function logout() {
    const token = sessionStorage.getItem("tilify_auth");
    setRole(null);
    setName("");
    setMemberId(null);
    setAuthenticated(false);
    sessionStorage.removeItem("tilify_auth");
    sessionStorage.removeItem("tuckshop_auth");
    if (token) {
      void db.rpc("end_till_session", { p_token: token });
    }
  }

  return (
    <AuthContext.Provider value={{ role, name, memberId, authenticated, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
