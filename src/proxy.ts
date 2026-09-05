import { NextRequest, NextResponse } from "next/server";

/**
 * Per-request CSP nonce. Replaces the static 'unsafe-inline' script-src that
 * used to live in next.config.ts's headers() (security-audit finding: CSP
 * allows unsafe-inline for scripts/styles). Next.js reads the nonce off the
 * CSP response header and automatically applies it to the script tags it
 * injects for hydration/chunk loading — no explicit `nonce` prop needed
 * anywhere in the app, since there are no hand-written inline <script> tags
 * in this codebase (confirmed by grep before writing this).
 *
 * Requires every route to render dynamically, not statically — a
 * statically-prerendered page bakes its script tags in at build time, when
 * no request (and so no nonce) exists yet, so they'd never match whatever
 * fresh nonce this proxy sets on the actual response and every script on
 * that page would be blocked. src/app/layout.tsx calls next/server's
 * connection() for exactly this reason — removing that call silently
 * breaks hydration on every route (this was caught in review before ever
 * reaching production: without it, nearly the entire app — including
 * /login — builds as static and would have shipped broken).
 *
 * style-src keeps 'unsafe-inline' — WITHOUT a nonce alongside it, unlike
 * script-src. That's deliberate, not an oversight: a nonce-source present
 * in a directive makes browsers ignore 'unsafe-inline' in that SAME
 * directive, so putting both in style-src would silently defeat the
 * 'unsafe-inline' half in every nonce-supporting browser (i.e. all of
 * them). The two can't usefully coexist in one directive; this app picks
 * 'unsafe-inline' for style-src because:
 * - Next's own <style> injection (styled-jsx, used in a few pages) and the
 *   hand-written <style> tags in the print-popup flow (lib/print-utils.ts
 *   and the 2 direct-HTML print builders in receive-stock/reorder) still
 *   work fine either way — those were converted to use CSS classes instead
 *   of inline style="" attributes, and 'unsafe-inline' allows their <style>
 *   elements regardless of the (now-inert, harmless) nonce attribute left
 *   on them.
 * - But ~14 other call sites across the app use React's `style={{...}}`
 *   prop for genuinely data-driven values (progress-bar widths/heights
 *   computed from live percentages, a viewport-relative modal height) that
 *   can't be expressed as a static class name Tailwind can see at build
 *   time. There is no nonce mechanism for inline style="" ATTRIBUTES at
 *   all (nonces only cover <style>/<script> ELEMENTS) — eliminating these
 *   would mean hand-converting each to an SVG-attribute or CSS-custom-
 *   property workaround, real redesign risk for a low-severity finding.
 * Browser-verified: with 'unsafe-inline' present and no nonce in style-src,
 * both the class-based <style> tags above AND these dynamic inline styles
 * render correctly. script-src has no such carve-out: it is fully nonce +
 * strict-dynamic, no unsafe-inline, full stop — that's the half of this
 * finding closed completely.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // React's dev-mode error-stack reconstruction uses eval(); Next's own CSP
  // guide requires 'unsafe-eval' in development for this reason. Production
  // never uses eval(), so script-src stays fully strict there.
  const scriptSrc = process.env.NODE_ENV === "development"
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  const cspHeader = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", cspHeader);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", cspHeader);
  return response;
}

export const proxyConfig = {
  // Excludes: Next's own static assets/images/favicon (never need a CSP
  // nonce), API routes (return JSON, no scripts to nonce), and prefetch
  // requests (next-router-prefetch / purpose:prefetch) — a prefetched RSC
  // payload bakes in the nonce from the moment it was prefetched, which
  // won't match the nonce enforced on the document the user is actually
  // viewing by the time a client-side transition uses it. This matches the
  // matcher Next's own CSP guide recommends for this exact nonce pattern.
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
