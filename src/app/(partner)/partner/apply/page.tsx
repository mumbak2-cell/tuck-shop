"use client";
// Public self-serve partner application at /partner/apply.
//
// Writes a pending row to partner_applications via POST /api/partners/apply.
// MK Global reviews the queue in /admin/partners and approves or rejects.
// No auth — a would-be partner may have no Tilify account yet.

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Handshake, Check, AlertCircle } from "lucide-react";

export default function PartnerApplyPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [requestedCode, setRequestedCode] = useState("");
  const [pitch, setPitch] = useState("");
  const [company, setCompany] = useState(""); // honeypot

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/partners/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          phone: phone || undefined,
          requested_code: requestedCode || undefined,
          pitch: pitch || undefined,
          company: company || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md mx-auto text-center">
        <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
          <Check className="w-6 h-6 text-green-700" />
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Application received</h1>
        <p className="text-sm text-gray-500 mb-6">
          MK Global will review it and email you at <span className="font-medium text-gray-700">{email}</span>.
          Once approved you&apos;ll get a referral code and access to your partner dashboard.
        </p>
        <Link href="/partner">
          <Button variant="secondary" className="w-full">Go to partner sign-in</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="text-center mb-6">
        <Handshake className="w-10 h-10 text-green-600 mx-auto mb-2" />
        <h1 className="text-2xl font-bold text-gray-900">Become a Tilify partner</h1>
        <p className="text-sm text-gray-500 mt-1">
          Refer shops to Tilify and earn a recurring commission on what they pay — every month they stay.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
        {/* Honeypot: hidden from real users, bots fill it. */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="hidden"
          aria-hidden="true"
        />

        <Field label="Full name" required>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="fld" />
        </Field>
        <Field label="Email" required>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            autoComplete="email" className="fld" />
        </Field>
        <Field label="Phone / WhatsApp">
          <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)}
            placeholder="+260..." className="fld" />
        </Field>
        <Field label="Referral code you'd like" hint="Optional. 3–32 chars: letters, numbers, hyphen. We confirm or adjust it on approval.">
          <input type="text" value={requestedCode}
            onChange={(e) => setRequestedCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))}
            placeholder="e.g. JANE2026" className="fld font-mono tracking-wider" />
        </Field>
        <Field label="How will you refer shops?" hint="Your network, region, past sales experience — a line or two.">
          <textarea value={pitch} onChange={(e) => setPitch(e.target.value)} rows={3} className="fld" />
        </Field>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button type="submit" loading={submitting} className="w-full">Submit application</Button>

        <p className="text-center text-xs text-gray-400">
          Already a partner?{" "}
          <Link href="/partner" className="text-green-700 hover:underline">Sign in</Link>
        </p>
      </form>

      <style jsx>{`
        .fld {
          width: 100%;
          border: 1px solid rgb(209, 213, 219);
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
        }
        .fld:focus {
          outline: none;
          border-color: rgb(34, 197, 94);
          box-shadow: 0 0 0 1px rgb(34, 197, 94);
        }
      `}</style>
    </div>
  );
}

function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
        {!required && <span className="text-xs text-gray-400 font-normal"> (optional)</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
