"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { PinPad } from "@/components/auth/pin-pad";
import { TrialBanner } from "@/components/layout/trial-banner";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { signOutSafely } from "@/lib/sign-out";

export default function WmsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { authenticated, role } = useAuth();
  const org = useOrg();

  useEffect(() => {
    if (!org.loading && !org.session) {
      router.replace("/login");
    } else if (!org.loading && org.session && org.orgId && !org.setupCompleted) {
      router.replace("/setup");
    }
  }, [org.loading, org.session, org.orgId, org.setupCompleted, router]);

  if (org.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  if (!org.session) return null;

  if (!org.orgId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center bg-white rounded-2xl shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900">No shop linked to this account</h2>
          <p className="text-sm text-gray-500 mt-2">
            Your account is signed in but not yet linked to a shop. Please contact support.
          </p>
          <button
            onClick={() => void signOutSafely(org, () => router.replace("/login"))}
            className="mt-4 text-sm text-green-700 font-medium hover:underline"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return <PinPad />;
  }

  // Warehouse operations are admin/owner only. The sidebar hides these links
  // for cashiers, but that is presentational — guard the route itself so a
  // cashier cannot reach a warehouse write page by typing the URL.
  if (role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center bg-white rounded-2xl shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900">
            Warehouse access is restricted
          </h2>
          <p className="text-sm text-gray-500 mt-2">
            Only owners and admins can manage warehouse stock. Ask an admin if
            you need access.
          </p>
          <button
            onClick={() => router.replace("/dashboard")}
            className="mt-4 text-sm text-green-700 font-medium hover:underline"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  // The warehouse module is opt-in per org (Settings → Warehouse Management).
  // The sidebar already hides these links when it is off; guard the route too
  // so it can't be reached by direct URL. Only admins get here, so point them
  // at the toggle rather than a generic "no access" message.
  if (!org.wmsEnabled) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center bg-white rounded-2xl shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900">
            Warehouse module is off
          </h2>
          <p className="text-sm text-gray-500 mt-2">
            Turn on Warehouse Management in Settings to receive, dispatch, and
            count warehouse stock.
          </p>
          <button
            onClick={() => router.replace("/settings")}
            className="mt-4 text-sm text-green-700 font-medium hover:underline"
          >
            Go to settings
          </button>
        </div>
      </div>
    );
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
