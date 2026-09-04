"use client";
// Team management. Lists org members and shows seat usage against the plan.
// Owners can add a cashier/manager (creating their login with a one-time
// temporary password) or remove one. Managers can view the team and change a
// cashier's branch — day-to-day floor management — but not add or remove
// staff. Renders nothing for cashiers.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useOrg, type PermissionKey } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Users, UserPlus, Trash2, AlertCircle } from "lucide-react";

interface Member {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  isSelf: boolean;
  isOwner: boolean;
  joinedAt: string;
  assignedLocationId: string | null;
  assignedLocationName: string | null;
  permissions: Record<string, boolean>;
  hasPin: boolean;
  displayName: string | null;
}

/** Admin functions an owner can grant to or withhold from a manager.
 *  Absence of a key, or anything but `false`, means granted. */
const PERMISSION_LABELS: { key: PermissionKey; label: string }[] = [
  { key: "manage_suppliers", label: "Suppliers" },
  { key: "manage_locations", label: "Locations" },
  { key: "manage_stock_transfers", label: "Stock transfers" },
  { key: "manage_expenses", label: "Expenses" },
  { key: "manage_payment_methods", label: "Payment methods" },
  { key: "view_reports", label: "Reports" },
  { key: "void_sales", label: "Void sales" },
  { key: "manage_blind_cashup", label: "Blind cash-up setting" },
  { key: "manage_warehouse", label: "Warehouse (WMS)" },
  { key: "manage_shift_admin", label: "Reopen/delete shifts" },
];

interface NewCredential {
  email: string;
  name?: string;
  emailSent: boolean;
  emailError?: string;
}

const ROLE_LABEL: Record<Member["role"], string> = {
  owner: "Owner",
  admin: "Manager",
  member: "Cashier",
};

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Not signed in");
  return t;
}

export function TeamSection() {
  const { role, locations } = useOrg();
  const [members, setMembers] = useState<Member[]>([]);
  const [seats, setSeats] = useState<{ used: number; max: number | null }>({ used: 0, max: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState("");
  const [memberRole, setMemberRole] = useState<"member" | "admin">("member");
  const [adding, setAdding] = useState(false);
  const [initialPin, setInitialPin] = useState("");

  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [pinValue, setPinValue] = useState("");
  const [pinSaving, setPinSaving] = useState(false);

  // Managers (admins) can only be added once the shop runs more than one
  // location; a single-branch shop is managed by the owner directly.
  const canAddManager = locations.length > 1;
  const [notice, setNotice] = useState<string | null>(null);
  const [credential, setCredential] = useState<NewCredential | null>(null);

  useEffect(() => {
    if (role !== "owner" && role !== "admin") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/team", { headers: { Authorization: `Bearer ${await token()}` } });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setMembers(json.members || []);
        setSeats(json.seats || { used: 0, max: null });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load team");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [role]);

  // Owners and managers only — cashiers manage nothing here.
  if (role !== "owner" && role !== "admin") return null;
  // Adding and removing staff stays with the owner.
  const canManageStaff = role === "owner";

  async function reload() {
    const res = await fetch("/api/team", { headers: { Authorization: `Bearer ${await token()}` } });
    const json = await res.json();
    if (res.ok) {
      setMembers(json.members || []);
      setSeats(json.seats || { used: 0, max: null });
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setNotice(null);
    setCredential(null);
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({
          email,
          name: name || undefined,
          role: memberRole,
          // A manager is never location-locked, so only send a restriction for a cashier.
          locationId: memberRole === "member" && locationId ? locationId : undefined,
          pin: initialPin || undefined,
          displayName: name || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not add team member");
      if (json.created) {
        setCredential({ email: json.email, name: json.name, emailSent: json.emailSent, emailError: json.emailError });
      } else {
        setNotice(json.message || `${json.email} was added to your team.`);
      }
      setEmail("");
      setName("");
      setLocationId("");
      setMemberRole("member");
      setInitialPin("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add team member");
    } finally {
      setAdding(false);
    }
  }

  /** Reassign a cashier's branch. A cashier with no branch can't see any stock,
   *  so the owner needs to be able to correct it without re-adding the person. */
  async function changeLocation(m: Member, locationId: string) {
    if (!locationId) return;
    setError(null);
    try {
      const res = await fetch(`/api/team/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ locationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not change branch");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change branch");
    }
  }

  /** Switch someone between Cashier and Manager. Owner only; promoting to
   *  manager is blocked below two locations, mirroring the add-form rule. */
  async function changeRole(m: Member, role: "admin" | "member") {
    if (role === "member" && !confirm(`Change ${m.email} to Cashier? They'll need a branch assigned below.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/team/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ role }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not change role");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change role");
    }
  }

  /** Grant or withdraw one admin function for a manager. Owner only. */
  async function togglePermission(m: Member, key: PermissionKey, granted: boolean) {
    const nextPermissions = { ...m.permissions, [key]: granted };
    // Optimistic update so the checkbox doesn't lag a round-trip.
    setMembers((prev) => prev.map((mem) => (mem.id === m.id ? { ...mem, permissions: nextPermissions } : mem)));
    setError(null);
    try {
      const res = await fetch(`/api/team/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ permissions: nextPermissions }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not update permission");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update permission");
      await reload();
    }
  }

  async function handleRemove(m: Member) {
    if (!confirm(`Remove ${m.email} from your shop? They will lose access on their next sign-in. Their login itself is not deleted.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/team/${m.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await token()}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not remove");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove");
    }
  }

  /** Owner sets or changes one member's PIN. */
  async function handleSetPin(m: Member) {
    if (!/^\d{4,6}$/.test(pinValue)) {
      setError("PIN must be 4–6 digits");
      return;
    }
    setPinSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/team/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ pin: pinValue }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not set PIN");
      setEditingPinId(null);
      setPinValue("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set PIN");
    } finally {
      setPinSaving(false);
    }
  }

  /** Owner clears a member's PIN — they fall back to the shared branch PIN. */
  async function handleClearPin(m: Member) {
    if (!confirm(`Remove ${m.email}'s PIN? They'll need to use the shared PIN.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/team/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ pin: null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not clear PIN");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear PIN");
    }
  }

  const atLimit = seats.max !== null && seats.used >= seats.max;

  return (
    <CollapsibleSection
      title="Team"
      icon={Users}
      badge={
        <span className="text-xs font-normal text-gray-400 ml-1">
          ({seats.max === null ? `${seats.used} users` : `${seats.used} of ${seats.max} seats`})
        </span>
      }
    >
      <p className="text-sm text-gray-500 mb-4">
        Give your team their own login. Each person counts as one seat on your plan.
      </p>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm mb-4">
          {notice}
        </div>
      )}

      {/* Credential hand-off — the password itself is never shown here, only emailed */}
      {credential && (
        credential.emailSent ? (
          <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm mb-4">
            Login details emailed to {credential.email}. Ask them to check their inbox (and spam folder) —
            they&apos;ll set a new password on their first sign-in.
          </div>
        ) : (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {credential.name || credential.email}&apos;s account was created, but the login email to{" "}
              {credential.email} failed to send{credential.emailError ? `: ${credential.emailError}` : ""}.
              They have no password yet — try adding them again or contact support.
            </span>
          </div>
        )
      )}

      {/* Member list */}
      <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg mb-5">
        {loading ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">Loading team...</div>
        ) : members.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">Just you so far.</div>
        ) : (
          members.map((m) => (
            <div key={m.id} className="px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {m.displayName || m.email}
                  {m.displayName && <span className="text-gray-400 font-normal text-xs ml-1">({m.email})</span>}
                  {m.isSelf && <span className="text-gray-400 font-normal"> (you)</span>}
                </p>
                {m.role === "member" && (
                  locations.length > 0 ? (
                    <div className="flex items-center gap-2 mt-0.5">
                      <select
                        value={m.assignedLocationId ?? ""}
                        onChange={(e) => void changeLocation(m, e.target.value)}
                        className={`text-xs border rounded px-1.5 py-0.5 bg-white ${
                          m.assignedLocationId ? "border-gray-200 text-gray-600" : "border-red-300 text-red-700"
                        }`}
                      >
                        <option value="">No branch — cannot sell</option>
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500 truncate">
                      {m.assignedLocationName || "No branch"}
                    </p>
                  )
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <Badge color={m.isOwner ? "green" : m.role === "admin" ? "blue" : "gray"}>
                  {ROLE_LABEL[m.role]}
                </Badge>
                {!m.isOwner && !m.isSelf && canManageStaff && (
                  m.role === "member" ? (
                    canAddManager && (
                      <button
                        type="button"
                        onClick={() => changeRole(m, "admin")}
                        className="text-xs text-blue-700 hover:underline whitespace-nowrap"
                      >
                        Make manager
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      onClick={() => changeRole(m, "member")}
                      className="text-xs text-gray-500 hover:underline whitespace-nowrap"
                    >
                      Make cashier
                    </button>
                  )
                )}
                {!m.isOwner && !m.isSelf && canManageStaff && (
                  <button
                    type="button"
                    onClick={() => handleRemove(m)}
                    aria-label={`Remove ${m.email}`}
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            {m.role === "admin" && canManageStaff && (
              <div className="mt-2 pt-2 border-t border-gray-100">
                <p className="text-xs text-gray-500 mb-1.5">Admin functions this manager can use:</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {PERMISSION_LABELS.map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={m.permissions[key] !== false}
                        onChange={(e) => void togglePermission(m, key, e.target.checked)}
                        className="w-3.5 h-3.5 text-green-600 border-gray-300 rounded focus:ring-green-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {!m.isOwner && canManageStaff && (
              <div className="mt-2 pt-2 border-t border-gray-100">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">PIN:</span>
                  {editingPinId === m.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={6}
                        value={pinValue}
                        onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
                        placeholder="4–6 digits"
                        className="w-24 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-green-500"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => handleSetPin(m)}
                        disabled={pinSaving || pinValue.length < 4}
                        className="text-xs text-green-700 hover:underline disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditingPinId(null); setPinValue(""); }}
                        className="text-xs text-gray-500 hover:underline"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {m.hasPin ? (
                        <>
                          <span className="text-xs text-green-700 font-medium">Set</span>
                          <button
                            type="button"
                            onClick={() => { setEditingPinId(m.id); setPinValue(""); }}
                            className="text-xs text-blue-600 hover:underline"
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            onClick={() => handleClearPin(m)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            Remove
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-xs text-gray-400">Not set</span>
                          <button
                            type="button"
                            onClick={() => { setEditingPinId(m.id); setPinValue(""); }}
                            className="text-xs text-blue-600 hover:underline"
                          >
                            Set PIN
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
            </div>
          ))
        )}
      </div>

      {/* Add form — owner only */}
      {!canManageStaff ? null : atLimit ? (
        <p className="text-sm text-amber-700">
          You have used all {seats.max} seats on your plan. Upgrade to add more cashiers.
        </p>
      ) : (
        <form onSubmit={handleAdd} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="cashier's email"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (optional)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={initialPin}
            onChange={(e) => setInitialPin(e.target.value.replace(/\D/g, ""))}
            placeholder="PIN (4–6 digits, optional)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
          {canAddManager && (
            <div>
              <select
                value={memberRole}
                onChange={(e) => setMemberRole(e.target.value as "member" | "admin")}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
              >
                <option value="member">Cashier</option>
                <option value="admin">Manager (full access, all branches)</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                A manager can see and run every branch. A cashier is limited to the POS.
              </p>
            </div>
          )}
          {memberRole === "member" && locations.length > 0 && (
            <div>
              <select
                required
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
              >
                <option value="">Which branch does this cashier work at? *</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Required. A cashier sells only at their branch — without one they can&apos;t see any stock.
              </p>
            </div>
          )}
          <Button
            type="submit"
            loading={adding}
            disabled={memberRole === "member" && locations.length > 0 && !locationId}
          >
            <UserPlus className="w-4 h-4 mr-1.5" />
            {memberRole === "admin" ? "Add manager" : "Add cashier"}
          </Button>
        </form>
      )}
    </CollapsibleSection>
  );
}
