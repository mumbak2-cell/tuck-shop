"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { PinPad } from "@/components/auth/pin-pad";
import { TrialBanner } from "@/components/layout/trial-banner";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";

export default function WmsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { authenticated } = useAuth();
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
            onClick={() => org.signOut().then(() => router.replace("/login"))}
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
