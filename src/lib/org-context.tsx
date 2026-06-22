"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase, db } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

export interface LocationRow {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  sort_order: number;
  active: boolean;
}

export interface OrgState {
  loading: boolean;
  session: Session | null;
  orgId: string | null;
  orgName: string | null;
  role: "owner" | "admin" | "member" | null;
  trialEndsAt: string | null;
  subscriptionPlan: string | null;
  subscriptionStatus: string | null;
  // Derived: true when the org can write data (trial active or paid)
  isWritable: boolean;
  // Days until trial expiry; negative when expired; null when not on a trial.
  trialDaysLeft: number | null;
  // Shop setup state (from app_settings)
  setupCompleted: boolean;
  preparesFood: boolean;
  shopType: string | null;
  // Sales workflow flexibility
  requiresShift: boolean;
  requiresStockCountToClose: boolean;
  // WMS module (parallel warehouse-system integration)
  wmsEnabled: boolean;
  wmsOnly: boolean;
  // Multi-location state
  locations: LocationRow[];
  currentLocationId: string | null;
  currentLocationName: string | null;
  /** Owners and admins can switch; cashiers are pinned to their assigned location. */
  canSwitchLocation: boolean;
  assignedLocationId: string | null;
  switchLocation: (locationId: string) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

function computeWritable(
  status: string | null,
  trialEndsAt: string | null,
  currentPeriodEnd: string | null
): boolean {
  if (status === "active") {
    // For paid subscriptions, also respect the current period end.
    // If a webhook has not extended the period, the org reverts to read-only.
    if (currentPeriodEnd && new Date(currentPeriodEnd).getTime() <= Date.now()) {
      return false;
    }
    return true;
  }
  if (status === "trialing" && trialEndsAt) {
    return new Date(trialEndsAt).getTime() > Date.now();
  }
  return false;
}

function computeDaysLeft(status: string | null, trialEndsAt: string | null): number | null {
  if (status !== "trialing" || !trialEndsAt) return null;
  const msLeft = new Date(trialEndsAt).getTime() - Date.now();
  return Math.ceil(msLeft / (1000 * 60 * 60 * 24));
}

const LOCATION_CACHE_KEY = "tilify_current_location";

const DEFAULT_STATE: OrgState = {
  loading: true,
  session: null,
  orgId: null,
  orgName: null,
  role: null,
  trialEndsAt: null,
  subscriptionPlan: null,
  subscriptionStatus: null,
  isWritable: false,
  trialDaysLeft: null,
  setupCompleted: false,
  preparesFood: false,
  shopType: null,
  requiresShift: false,
  requiresStockCountToClose: false,
  wmsEnabled: false,
  wmsOnly: false,
  locations: [],
  currentLocationId: null,
  currentLocationName: null,
  canSwitchLocation: false,
  assignedLocationId: null,
  switchLocation: () => {},
  refresh: async () => {},
  signOut: async () => {},
};

const OrgContext = createContext<OrgState>(DEFAULT_STATE);

export function useOrg() {
  return useContext(OrgContext);
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OrgState>(DEFAULT_STATE);

  function pickCurrentLocation(
    locations: LocationRow[],
    assignedLocationId: string | null,
    role: "owner" | "admin" | "member" | null
  ): LocationRow | null {
    if (locations.length === 0) return null;
    // Cashiers are pinned to their assigned location.
    if (role === "member" && assignedLocationId) {
      const pinned = locations.find((l) => l.id === assignedLocationId);
      if (pinned) return pinned;
    }
    // Owners and admins: restore last-selected from localStorage if still valid.
    try {
      if (typeof window !== "undefined") {
        const cached = window.localStorage.getItem(LOCATION_CACHE_KEY);
        if (cached) {
          const match = locations.find((l) => l.id === cached);
          if (match) return match;
        }
      }
    } catch {
      // ignore
    }
    return locations[0];
  }

  async function loadOrg(session: Session | null) {
    if (!session) {
      setState((s) => ({
        ...DEFAULT_STATE,
        loading: false,
        switchLocation: s.switchLocation,
        refresh: s.refresh,
        signOut: s.signOut,
      }));
      return;
    }

    // Pull the user's org membership and the org row (RLS scoped automatically).
    const { data: membership } = await db
      .from("org_members")
      .select("org_id, role, assigned_location_id, organizations(id, name, trial_ends_at, subscription_plan, subscription_status, current_period_end)")
      .eq("user_id", session.user.id)
      .limit(1)
      .maybeSingle();

    if (!membership) {
      setState((s) => ({
        ...DEFAULT_STATE,
        loading: false,
        session,
        switchLocation: s.switchLocation,
        refresh: s.refresh,
        signOut: s.signOut,
      }));
      return;
    }

    const org = membership.organizations;
    const status = org?.subscription_status ?? null;
    const trialEndsAt = org?.trial_ends_at ?? null;
    const currentPeriodEnd = org?.current_period_end ?? null;
    const role = (membership.role as OrgState["role"]) ?? null;
    const assignedLocationId = (membership as { assigned_location_id?: string | null }).assigned_location_id ?? null;

    // Pull setup + workflow + WMS settings (single round-trip, RLS-scoped)
    const { data: settingsRows } = await db
      .from("app_settings")
      .select("key, value")
      .in("key", [
        "setup_completed",
        "prepares_food",
        "shop_type",
        "requires_shift",
        "requires_stock_count_to_close",
        "wms_enabled",
        "wms_only",
      ]);

    const settingsMap: Record<string, string> = {};
    ((settingsRows || []) as { key: string; value: string }[]).forEach((row) => {
      settingsMap[row.key] = row.value;
    });

    // Pull the locations the user can see (RLS handles cashier scoping).
    const { data: locRows } = await db
      .from("locations")
      .select("id, name, address, phone, sort_order, active")
      .eq("active", true)
      .order("sort_order");
    const locations = (locRows as LocationRow[]) || [];

    const currentLocation = pickCurrentLocation(locations, assignedLocationId, role);

    setState((s) => ({
      ...s,
      loading: false,
      session,
      orgId: membership.org_id,
      orgName: org?.name ?? null,
      role,
      trialEndsAt,
      subscriptionPlan: org?.subscription_plan ?? null,
      subscriptionStatus: status,
      isWritable: computeWritable(status, trialEndsAt, currentPeriodEnd),
      trialDaysLeft: computeDaysLeft(status, trialEndsAt),
      setupCompleted: settingsMap.setup_completed === "true",
      preparesFood: settingsMap.prepares_food === "true",
      shopType: settingsMap.shop_type ?? null,
      requiresShift: settingsMap.requires_shift === "true",
      requiresStockCountToClose: settingsMap.requires_stock_count_to_close === "true",
      wmsEnabled: settingsMap.wms_enabled === "true",
      wmsOnly: settingsMap.wms_only === "true",
      locations,
      currentLocationId: currentLocation?.id ?? null,
      currentLocationName: currentLocation?.name ?? null,
      canSwitchLocation: role === "owner" || role === "admin",
      assignedLocationId,
    }));
  }

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (mounted) loadOrg(session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) loadOrg(session);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchLocation(locationId: string) {
    setState((s) => {
      // Cashiers cannot switch off their assigned location.
      if (!(s.role === "owner" || s.role === "admin")) return s;
      const match = s.locations.find((l) => l.id === locationId);
      if (!match) return s;
      try {
        window.localStorage.setItem(LOCATION_CACHE_KEY, match.id);
      } catch {
        // ignore
      }
      return {
        ...s,
        currentLocationId: match.id,
        currentLocationName: match.name,
      };
    });
  }

  const value: OrgState = {
    ...state,
    switchLocation,
    refresh: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      await loadOrg(session);
    },
    signOut: async () => {
      await supabase.auth.signOut();
      try {
        sessionStorage.removeItem("tilify_auth");
        sessionStorage.removeItem("tuckshop_auth");
        window.localStorage.removeItem(LOCATION_CACHE_KEY);
      } catch {
        // ignore
      }
    },
  };

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export const TILIFY_LOCATION_CACHE_KEY = LOCATION_CACHE_KEY;
