# Implementation brief — renewal banner for paid subscriptions

**Author:** Opus planning session, 2026-09-07
**Builder:** Sonnet session
**Branch:** `feat/billing-renewal-banner`
**Scope:** one component file. No API route, no migration, no new component.
**Design approved by Mumba** 2026-09-07, including the visibility choice (owners + admins).

---

## Why

A paying org approaching the end of its billing period gets **no warning of any kind**.

`src/components/layout/trial-banner.tsx:11` returns `null` unless
`subscription_status === 'trialing'`. Every other state — `active` nearing expiry, `active`
expired, `past_due` — renders nothing.

This is not hypothetical. Chichi's Bakes and Accessories had `current_period_end` of
2026-08-01. `computeWritable` (`src/lib/org-context.tsx:120-137`) correctly returns `false`
for an `active` org past its period end, so **the app went read-only for her on 1 August
and never explained why**. She had in fact paid, by bank transfer, while the Paystack keys
were broken. Her period has since been corrected.

The recurring-billing machinery is already complete: `api/billing/initiate` passes a
Paystack Plan code so Paystack creates an auto-renewing Subscription, and
`api/billing/webhook/paystack` rolls `current_period_end` forward via `addCycle` on the
renewal `charge.success`, and handles `past_due` and `cancelled`. All nine
`PAYSTACK_PLAN_*` env vars are set in production with live-mode codes.

So nothing about billing needs building. The only gap is that nobody is told.

---

## What to build

One file: `src/components/layout/trial-banner.tsx`.

Keep the existing trial branch exactly as it is. Add a second branch for paid subscriptions
below it, reusing the same markup structure, spacing and colour treatment already in the
file — this must look like one banner component, not two glued together.

### Visibility gate

Render nothing unless `role` is `'owner'` or `'admin'`.

`api/billing/initiate` calls `requireOrgOwner`, so an admin who clicks through will get a
403. Show them the banner anyway — Mumba's call, they need to know the shop is about to go
read-only — but that means **an admin must not be shown a button that 403s**. For
`role === 'admin'`, render the message with no button and the trailing sentence
"Ask the account owner to renew." For `role === 'owner'`, render the button.

Cashiers (`role === 'member'`) see nothing.

### States

`currentPeriodEnd` is already on `OrgState`. Compute days remaining in the component the
same way `computeDaysLeft` does for trials — do not add a second helper to `org-context.tsx`.

| Condition | Render |
|---|---|
| `status === 'active'`, more than 7 days left | nothing |
| `status === 'active'`, 7 days or fewer, more than 0 | Amber. "Your plan renews in N days." Button: "Manage billing" |
| `status === 'active'`, 1 day left | Amber. "Your plan renews tomorrow." |
| `status === 'active'`, period passed | Red. "Your plan has expired. The app is read-only until you renew." Button: "Renew now" |
| `status === 'past_due'` | Red. "Your last payment did not go through. Renew to keep saving sales." Button: "Renew now" |
| `status === 'cancelled'`, period not yet passed | Amber. "Your plan ends on <date> and will not renew." Button: "Reactivate" |
| anything else | nothing |

Every button opens the existing `PricingModal`, same as the trial branch does. Do not add a
new modal, route or handler.

Match the existing amber/red class strings in the file rather than inventing new ones.

### Deliberately NOT in scope

- **Do not rename the component or the file.** `TrialBanner` becomes a slightly inaccurate
  name; that is accepted. Renaming touches two import sites for no functional gain.
- Do not modify `org-context.tsx`. `currentPeriodEnd`, `role` and `isWritable` are all
  already exposed.
- Do not modify any billing API route, the webhook, or `paystack-plans.ts`.
- Do not add a dismiss/snooze control. Not asked for.
- Do not change the trial branch's copy, thresholds or styling.

---

## Verification

There is no test framework for this component, so verification is manual. Do all of it and
report what you saw.

Against a **non-production** org, set `organizations.current_period_end` and
`subscription_status` by hand and reload:

1. `active`, period end 30 days out → no banner.
2. `active`, period end 5 days out → amber, "renews in 5 days", button present as owner.
3. `active`, period end 1 day out → amber, "renews tomorrow".
4. `active`, period end yesterday → red, read-only wording, "Renew now".
5. `past_due` → red, failed-payment wording.
6. `cancelled`, period end in future → amber, end-date wording.
7. Same org as an **admin** → banner shows, no button, "Ask the account owner to renew."
8. Same org as a **member** → nothing renders.
9. `trialing` org → the existing trial banner behaves exactly as before. This is the
   regression check that matters most.
10. Clicking the button opens `PricingModal` and a checkout can be initiated as owner.

Also confirm `npm run build`, `npx tsc --noEmit` and `npm run lint` are clean.

Do not claim a state passes without having actually rendered it.

---

## Constraints

- `main` auto-deploys production. Open the PR, do not merge. Mumba merges.
- Do not test by editing production org rows.
- Surgical: one file. Match the file's existing style even where you would write it
  differently.

## PR

- Branch `feat/billing-renewal-banner`, one PR.
- Title: `feat: warn paid orgs before their billing period ends`
- Body: list which of the ten verification states you rendered and what each showed.
- Flag anything you chose not to do and why.
