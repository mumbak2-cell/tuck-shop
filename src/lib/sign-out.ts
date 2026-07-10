"use client";
// Shared sign-out handler for the layout "Sign out" buttons.
//
// org.signOut() refuses to run while unsynced writes sit in the offline
// queue, because that queue is the only copy of those sales. This wraps it
// so the cashier is told what they would lose and has to say so explicitly.

import { PendingSyncError, type OrgState } from "@/lib/org-context";

export async function signOutSafely(
  org: Pick<OrgState, "signOut">,
  onDone: () => void
): Promise<void> {
  try {
    await org.signOut();
    onDone();
    return;
  } catch (e) {
    if (!(e instanceof PendingSyncError)) {
      alert(
        "Could not sign out: " + (e instanceof Error ? e.message : "Unknown error")
      );
      return;
    }

    const noun = e.pending === 1 ? "sale or entry" : "sales or entries";
    const discard = window.confirm(
      `⚠ ${e.pending} ${noun} on this device have not reached the server yet.\n\n` +
        `Signing out now deletes them permanently. They cannot be recovered.\n\n` +
        `Connect to the internet and wait for the sync to finish, or sign out and lose this work.`
    );
    if (!discard) return;
  }

  // Only reached when the cashier explicitly chose to discard.
  await org.signOut({ discardPending: true });
  onDone();
}
