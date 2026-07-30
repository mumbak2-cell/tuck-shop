import type { Metadata } from "next";
import { COMPANY, PageShell } from "../_company";

export const metadata: Metadata = {
  title: "Refund & Cancellation Policy — Tilify",
  description: "How Tilify subscription cancellations and refunds work.",
};

export default function RefundPolicyPage() {
  return (
    <PageShell title="Refund & Cancellation Policy">
      <p>
        This policy explains how cancellations and refunds work for {COMPANY.product}, a
        subscription service provided by {COMPANY.legalName}. It forms part of our{" "}
        <a href="/terms">Terms of Service</a>.
      </p>

      <h2>Free trial</h2>
      <p>
        Every plan begins with a 14-day free trial. You are not charged during the trial and
        can stop before it ends without any payment.
      </p>

      <h2>Billing</h2>
      <p>
        After the trial, subscriptions are billed in advance in South African Rand (ZAR)
        through Paystack, on a monthly, quarterly or annual cycle as selected. Each cycle
        renews automatically until you cancel.
      </p>

      <h2>Cancellation</h2>
      <p>
        You can cancel your subscription at any time from Settings → Plan &amp; Billing inside
        the app, or by emailing{" "}
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>. When you cancel:
      </p>
      <ul>
        <li>your subscription stops renewing, so you are not charged again;</li>
        <li>you keep access to your plan until the end of the period you have already paid for;</li>
        <li>your data remains available to export for a reasonable period after the paid term ends.</li>
      </ul>

      <h2>Refunds</h2>
      <p>
        Because access continues for the full period you have paid for, subscription fees are
        generally non-refundable for partial or unused periods. However, we will provide a
        refund in these cases:
      </p>
      <ul>
        <li>
          <strong>Duplicate or erroneous charge:</strong> if you are charged in error or more
          than once for the same period, we refund the incorrect amount in full.
        </li>
        <li>
          <strong>7-day goodwill window:</strong> if you cancel within 7 days of your first
          paid charge (i.e. the first charge after your trial) and have not made substantial
          use of the service, contact us and we will refund that charge.
        </li>
        <li>
          <strong>Service failure:</strong> if a prolonged fault on our side prevents you from
          using the service, we will refund or credit the affected period.
        </li>
      </ul>

      <h2>How to request a refund</h2>
      <p>
        Email <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> with the account email and
        the charge date. Approved refunds are returned to the original payment method via
        Paystack, normally within 5–10 business days.
      </p>

      <h2>Contact</h2>
      <p>
        {COMPANY.legalName}<br />
        {COMPANY.address}<br />
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> · {COMPANY.phone}
      </p>
    </PageShell>
  );
}
