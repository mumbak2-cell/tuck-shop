import type { Metadata } from "next";
import { COMPANY, PageShell } from "../_company";

export const metadata: Metadata = {
  title: "Terms of Service — Tilify",
  description: "The terms governing use of the Tilify service.",
};

export default function TermsPage() {
  return (
    <PageShell title="Terms of Service">
      <p>
        These Terms of Service (&quot;Terms&quot;) govern your access to and use of {COMPANY.product},
        a software service provided by {COMPANY.legalName} (registration no. {COMPANY.regNo}),
        a company incorporated in South Africa (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;). By creating an account
        or using {COMPANY.product}, you agree to these Terms.
      </p>

      <h2>1. The service</h2>
      <p>
        {COMPANY.product} provides point-of-sale, inventory management, reporting and
        revenue-assurance tools for retail businesses. We may update, improve or change
        features from time to time.
      </p>

      <h2>2. Accounts</h2>
      <p>
        You must provide accurate information when registering and keep your login
        credentials secure. You are responsible for all activity under your account and
        for the users you add to your organisation. You must be authorised to act on
        behalf of the business you register.
      </p>

      <h2>3. Subscriptions, billing and renewal</h2>
      <p>
        {COMPANY.product} is offered on a subscription basis. Fees, billing cycles and plan
        limits are described on our <a href="/pricing">Pricing</a> page. Subscriptions are
        billed in advance in South African Rand (ZAR) through our payment processor,
        Paystack, and renew automatically at the end of each cycle until cancelled.
        Cancellation and refunds are governed by our{" "}
        <a href="/refund-policy">Refund &amp; Cancellation Policy</a>. We may change our
        fees on reasonable notice; changes take effect at your next renewal.
      </p>

      <h2>4. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the service for any unlawful purpose or in breach of any applicable law;</li>
        <li>attempt to gain unauthorised access to the service, other accounts, or our systems;</li>
        <li>interfere with or disrupt the integrity or performance of the service;</li>
        <li>resell, sublicense or misrepresent the service without our written permission.</li>
      </ul>

      <h2>5. Your data</h2>
      <p>
        You retain ownership of the business and customer data you enter into {COMPANY.product}.
        You grant us the limited right to host and process that data to provide the service.
        We take reasonable measures to protect your data and process personal information in
        line with applicable South African data-protection law (POPIA). We do not sell your data.
      </p>

      <h2>6. Payment processing</h2>
      <p>
        Card and payment details for subscription billing are collected and processed by
        Paystack under Paystack&apos;s own terms and security standards. We do not store full
        card numbers on our servers.
      </p>

      <h2>7. Availability and disclaimers</h2>
      <p>
        We work to keep {COMPANY.product} available and reliable, but the service is provided
        &quot;as is&quot; without warranties of any kind, to the maximum extent permitted by law. We
        do not warrant that the service will be uninterrupted or error-free.
      </p>

      <h2>8. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, {COMPANY.legalName} will not be liable for any
        indirect, incidental or consequential loss. Our total liability arising out of or in
        connection with the service is limited to the fees you paid to us in the three months
        preceding the event giving rise to the claim.
      </p>

      <h2>9. Termination</h2>
      <p>
        You may stop using the service and cancel your subscription at any time. We may
        suspend or terminate access if you materially breach these Terms or fail to pay fees
        due. On termination you may export your data for a reasonable period before it is
        removed.
      </p>

      <h2>10. Governing law</h2>
      <p>
        These Terms are governed by the laws of the Republic of South Africa, and the courts
        of South Africa have jurisdiction over any dispute.
      </p>

      <h2>11. Contact</h2>
      <p>
        {COMPANY.legalName}<br />
        {COMPANY.address}<br />
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> · {COMPANY.phone}
      </p>
    </PageShell>
  );
}
