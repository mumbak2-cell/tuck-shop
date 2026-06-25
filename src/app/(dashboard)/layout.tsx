"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { PinPad } from "@/components/auth/pin-pad";
import { TrialBanner } from "@/components/layout/trial-banner";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { useOnline } from "@/lib/use-online";
import { WifiOff } from "lucide-react";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { authenticated } = useAuth();
  const org = useOrg();
  const online = useOnline();

  // While org context is loading the session and membership, show a brief loader.
  useEffect(() => {
    if (!org.loading && !org.session) {
      router.replace("/login");
    } else if (!org.loading && org.session && org.orgId && !org.setupCompleted) {
      router.replace("/setup");
    }
  }, [org.loading, org.session, org.orgId, org.setupCompleted, router]);

  // When the network comes back, if the org load failed during the outage
  // (org.orgId still null but we have a session), retry the load automatically
  // so the cashier doesn't have to refresh manually.
  useEffect(() => {
    if (online && org.session && !org.orgId) {
      org.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  if (org.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  // No Supabase session - redirect handled by the effect above; render nothing.
  if (!org.session) {
    return null;
  }

  // Signed in but no organization membership. Two distinct cases:
  //   1. Truly no org (sign-up edge case) — show the genuine help message.
  //   2. Offline and org couldn't be fetched from Supabase — show honest
  //      "you're offline" UI with NO destructive Sign Out button so a
  //      cashier under pressure doesn't kill their session.
  if (!org.orgId) {
    if (!online) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-amber-50">
          <div className="max-w-md text-center bg-white rounded-2xl shadow p-6 border border-amber-200">
            <WifiOff className="w-10 h-10 text-amber-600 mx-auto mb-3" />
            <h2 className="text-lg font-semibold text-gray-900">You&apos;re offline</h2>
            <p className="text-sm text-gray-600 mt-2">
              Your shop will load as soon as the connection comes back. Stay on this screen —
              do not sign out. Your session is still active.
            </p>
            <p className="text-xs text-gray-400 mt-4">Tilify is retrying in the background.</p>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center bg-white rounded-2xl shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900">No shop linked to this account</h2>
          <p className="text-sm text-gray-500 mt-2">
            Your account is signed in but not yet linked to a shop. Please contact MK Global support
            at mumbak2@gmail.com, or sign out and create a new shop.
          </p>
          <button
            onClick={() => org.signOut().then(() => router.replace("/login"))}
            className="mt-4 text-sm text-green-700 font-medium hover:underline"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // Operator account is signed in and linked to a shop, but the device PIN
  // session has not been entered yet. Show the PIN pad as the secondary auth.
  if (!authenticated) {
    return <PinPad />;
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto flex flex-col">
        <TrialBanner />
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 flex-1">
          {children}
        </div>
      </main>
    </div>
  );
}
