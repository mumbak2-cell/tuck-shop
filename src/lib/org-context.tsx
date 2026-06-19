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
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

function computeWritable(status: string | null, trialEndsAt: string | null): boolean {
  if (status === "active") return true;
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

const OrgContext = createContext<OrgState>({
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
  refresh: async () => {},
  signOut: async () => {},
});

export function useOrg() {
  return useContext(OrgContext);
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OrgState>({
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
    refresh: async () => {},
    signOut: async () => {},
  });

  async function loadOrg(session: Session | null) {
    if (!session) {
      setState((s) => ({
        ...s,
        loading: false,
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
      }));
      return;
    }

    // Pull the user's org membership and the org row (RLS scoped automatically).
    const { data: membership } = await db
      .from("org_members")
      .select("org_id, role, organizations(id, name, trial_ends_at, subscription_plan, subscription_status)")
      .eq("user_id", session.user.id)
      .limit(1)
      .maybeSingle();

    if (!membership) {
      setState((s) => ({
        ...s,
        loading: false,
        session,
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
      }));
      return;
    }

    const org = membership.organizations;
    const status = org?.subscription_status ?? null;
    const trialEndsAt = org?.trial_ends_at ?? null;

    // Pull the setup-related settings (single round trip, RLS scoped to the org)
    const { data: settingsRows } = await db
      .from("app_settings")
      .select("key, value")
      .in("key", ["setup_completed", "prepares_food", "shop_type"]);

    const settingsMap: Record<string, string> = {};
    ((settingsRows || []) as { key: string; value: string }[]).forEach((row) => {
      settingsMap[row.key] = row.value;
    });

    setState((s) => ({
      ...s,
      loading: false,
      session,
      orgId: membership.org_id,
      orgName: org?.name ?? null,
      role: membership.role,
      trialEndsAt,
      subscriptionPlan: org?.subscription_plan ?? null,
      subscriptionStatus: status,
      isWritable: computeWritable(status, trialEndsAt),
      trialDaysLeft: computeDaysLeft(status, trialEndsAt),
      setupCompleted: settingsMap.setup_completed === "true",
      preparesFood: settingsMap.prepares_food === "true",
      shopType: settingsMap.shop_type ?? null,
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

  const value: OrgState = {
    ...state,
    refresh: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      await loadOrg(session);
    },
    signOut: async () => {
      await supabase.auth.signOut();
      // Clear device-level PIN session too
      try {
        sessionStorage.removeItem("tilify_auth");
        sessionStorage.removeItem("tuckshop_auth");
      } catch {
        // ignore
      }
    },
  };

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}
