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
import { startSyncLoop, stopSyncLoop, flushQueue } from "@/lib/offline-sync";
import { clearOfflineStore, pendingCount } from "@/lib/offline-store";

/**
 * Thrown by signOut() when the device still holds unsynced writes. The queue
 * is the only copy of those sales — signing out would delete them. Callers
 * should surface `pending` to the user and, if they choose to lose the work,
 * retry with `signOut({ discardPending: true })`.
 */
export class PendingSyncError extends Error {
  readonly pending: number;
  constructor(pending: number) {
    super(
      `${pending} ${pending === 1 ? "operation has" : "operations have"} not reached the server yet.`
    );
    this.name = "PendingSyncError";
    this.pending = pending;
  }
}

/**
 * Admin-gated functions an owner can grant to or withhold from a manager
 * (org_members.role = 'admin') individually. Absence of a key, or a key set
 * to anything other than `false`, means granted — see org_members.permissions
 * (migration 077).
 */
export type PermissionKey =
  | "manage_suppliers"
  | "manage_locations"
  | "manage_stock_transfers"
  | "manage_expenses"
  | "manage_payment_methods"
  | "view_reports"
  | "void_sales"
  | "manage_blind_cashup";

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
  // Per-manager permission toggles (org_members.permissions). Only meaningful
  // when role === "admin" — see `can`.
  permissions: Record<string, boolean>;
  trialEndsAt: string | null;
  subscriptionPlan: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
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
  // Stock mode: "per_location" (each shop holds its own stock) or
  // "central" (McDonald's pattern — one shared pool across shops).
  // Default per_location. Behavior is identical under the hood; this
  // setting is a UX hint for stock screens.
  stockMode: "per_location" | "central";
  // Tax fields (displayed on receipts)
  tpin: string | null;
  vatPercent: number | null;
  // Admin-configurable low-stock threshold (units). 0 or above. Default 5.
  lowStockThreshold: number;
  // Currency code (ISO 4217, e.g. "ZAR", "ZMW") — used for phone country code derivation
  currency: string | null;
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
  /** Owners can do everything; a manager (role "admin") needs the matching
   *  permission key not explicitly revoked; cashiers can do none of these. */
  can: (key: PermissionKey) => boolean;
  refresh: () => Promise<void>;
  /**
   * Signs the user out and clears their offline data. Throws PendingSyncError
   * if unsynced writes remain; pass `discardPending` to delete them anyway.
   */
  signOut: (opts?: { discardPending?: boolean }) => Promise<void>;
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
const LAST_ORG_ID_KEY = "tilify_last_org_id";

/** Whether the user has ever had a working org session on this device.
 * Used by the dashboard layout to suppress fallback screens that would
 * otherwise fire when state momentarily empties (e.g. spurious auth events
 * while offline). */
export function hasEverHadOrg(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage.getItem(LAST_ORG_ID_KEY);
  } catch {
    return false;
  }
}

const DEFAULT_STATE: OrgState = {
  loading: true,
  session: null,
  orgId: null,
  orgName: null,
  role: null,
  permissions: {},
  trialEndsAt: null,
  subscriptionPlan: null,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  isWritable: false,
  trialDaysLeft: null,
  setupCompleted: false,
  preparesFood: false,
  shopType: null,
  requiresShift: false,
  requiresStockCountToClose: false,
  stockMode: "per_location",
  tpin: null,
  vatPercent: null,
  lowStockThreshold: 5,
  currency: null,
  wmsEnabled: false,
  wmsOnly: false,
  locations: [],
  currentLocationId: null,
  currentLocationName: null,
  canSwitchLocation: false,
  assignedLocationId: null,
  switchLocation: () => {},
  can: () => false,
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

    // Offline guard: if we're already signed in (have a session) but the
    // network is down, keep whatever org state we already have. Don't try
    // to fetch fresh data over a dead connection and don't blank the
    // org. Without this guard, a spurious auth event while offline could
    // strip orgId and bounce the user to the offline fallback screen.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setState((s) => ({ ...s, loading: false, session }));
      return;
    }

    // Pull the user's org membership and the org row (RLS scoped automatically).
    const { data: membership } = await db
      .from("org_members")
      .select("org_id, role, assigned_location_id, permissions, organizations(id, name, trial_ends_at, subscription_plan, subscription_status, current_period_end, tpin, vat_percent)")
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
    const permissions = (membership as { permissions?: Record<string, boolean> }).permissions ?? {};

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
        "stock_mode",
        "wms_enabled",
        "wms_only",
        "currency",
        "low_stock_threshold",
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

    // Remember on this device that the user successfully loaded an org. The
    // dashboard layout consults this when state momentarily empties so the
    // user never sees the offline / no-shop fallbacks again on subsequent
    // navigations.
    try {
      window.localStorage.setItem(LAST_ORG_ID_KEY, membership.org_id);
    } catch {
      // ignore — non-critical
    }

    setState((s) => ({
      ...s,
      loading: false,
      session,
      orgId: membership.org_id,
      orgName: org?.name ?? null,
      role,
      permissions,
      trialEndsAt,
      subscriptionPlan: org?.subscription_plan ?? null,
      subscriptionStatus: status,
      currentPeriodEnd,
      isWritable: computeWritable(status, trialEndsAt, currentPeriodEnd),
      trialDaysLeft: computeDaysLeft(status, trialEndsAt),
      setupCompleted: settingsMap.setup_completed === "true",
      preparesFood: settingsMap.prepares_food === "true",
      shopType: settingsMap.shop_type ?? null,
      requiresShift: settingsMap.requires_shift === "true",
      requiresStockCountToClose: settingsMap.requires_stock_count_to_close === "true",
      stockMode: settingsMap.stock_mode === "central" ? "central" : "per_location",
      tpin: org?.tpin ?? null,
      vatPercent: org?.vat_percent != null ? Number(org.vat_percent) : null,
      lowStockThreshold:
        settingsMap.low_stock_threshold != null && Number(settingsMap.low_stock_threshold) >= 0
          ? Number(settingsMap.low_stock_threshold)
          : 5,
      currency: settingsMap.currency ?? null,
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

    // Only respond to events that genuinely change auth state. Token refresh
    // failures while offline can trigger spurious callbacks that would wipe
    // org.orgId to null, and the dashboard layout would then show the offline
    // fallback even though the user is still legitimately signed in.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
        loadOrg(session);
      } else if (event === "SIGNED_OUT") {
        loadOrg(null);
      }
      // TOKEN_REFRESHED / USER_UPDATED / PASSWORD_RECOVERY: state already
      // correct, don't re-fetch and don't blank the org.
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start (or restart) the offline sync loop whenever the signed-in org changes.
  // It refreshes the local cache from Supabase on mount, runs every 5 minutes,
  // and drains the write queue whenever the browser comes back online.
  useEffect(() => {
    if (!state.orgId) {
      stopSyncLoop();
      return;
    }
    const stop = startSyncLoop(state.orgId);
    return () => stop();
  }, [state.orgId]);

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

  function can(key: PermissionKey): boolean {
    if (state.role === "owner") return true;
    if (state.role === "admin") return state.permissions[key] !== false;
    return false;
  }

  const value: OrgState = {
    ...state,
    switchLocation,
    can,
    refresh: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      await loadOrg(session);
    },
    signOut: async (opts = {}) => {
      // Resolve the org from the last-known id as well as live state. The only
      // Sign out button renders inside the `!org.orgId` branch of the dashboard
      // and WMS layouts, so state.orgId is null exactly when this runs — the
      // old `if (state.orgId)` guard meant the cleanup never fired at all.
      let orgId = state.orgId;
      if (!orgId) {
        try { orgId = window.localStorage.getItem(LAST_ORG_ID_KEY); } catch { orgId = null; }
      }

      if (orgId) {
        // Last chance to get queued sales to the server. flushQueue is a no-op
        // when offline, and returns without draining if a sync is already in
        // flight, so re-read the count afterwards rather than trusting `sent`.
        if (pendingCount(orgId) > 0 && navigator.onLine) {
          try { await flushQueue(orgId); } catch { /* fall through to the check */ }
        }

        const stillPending = pendingCount(orgId);
        if (stillPending > 0 && !opts.discardPending) {
          // Abort before signing out. Nothing has been cleared at this point.
          throw new PendingSyncError(stillPending);
        }

        try {
          clearOfflineStore(orgId, { discardQueue: opts.discardPending });
        } catch { /* ignore */ }
      }

      stopSyncLoop();
      await supabase.auth.signOut();
      try {
        sessionStorage.removeItem("tilify_auth");
        sessionStorage.removeItem("tuckshop_auth");
        window.localStorage.removeItem(LOCATION_CACHE_KEY);
        window.localStorage.removeItem(LAST_ORG_ID_KEY);
      } catch {
        // ignore
      }
    },
  };

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export const TILIFY_LOCATION_CACHE_KEY = LOCATION_CACHE_KEY;
