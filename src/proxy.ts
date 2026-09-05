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
  const cspHeader = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", cspHeader);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", cspHeader);
  return response;
}

export const proxyConfig = {
  matcher: ["/:path*"],
};
