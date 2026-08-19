// Tilify service worker — offline-first PWA shell.
//
// Strategy:
//
//   • App shell (HTML navigations) — try network, fall back to cached shell,
//     fall back to the static offline page. So during a blackout the cashier
//     still gets the dashboard scaffolding loaded from cache.
//
//   • Static assets (JS, CSS, fonts, images served from /_next/static or /
//     with hashed filenames) — cache-first. They are immutable per build, so
//     once cached they never go to the network.
//
//   • API / Supabase calls — pass through to the network. We rely on the
//     in-app localStorage queue (see src/lib/offline-store.ts) to handle
//     offline writes; the service worker stays out of business logic.
//
//   • New SW activation — skipWaiting + clients.claim so the new version
//     replaces the old one as soon as it's downloaded. The client side will
//     show an "App update available, tap to refresh" toast when this
//     happens (Slice 9 follow-up).

// Bump on each deploy to purge stale caches.
const CACHE_VERSION = "tilify-v4";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const SHELL_URL = "/";
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll([SHELL_URL, OFFLINE_URL]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Delete any caches that don't match the current version.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))
      );
      // Take control of all open clients immediately.
      await self.clients.claim();
    })()
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    /\.(?:js|css|woff2?|ttf|eot|png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname)
  );
}

function isSupabaseOrApi(url) {
  // Anything that should never come out of cache: API routes and Supabase.
  return (
    url.pathname.startsWith("/api/") ||
    url.host.endsWith("supabase.co") ||
    url.host.includes("supabase.in")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Don't touch API or Supabase traffic — let it through and let the in-app
  // offline queue handle failures.
  if (isSupabaseOrApi(url)) return;

  // Navigation requests: try network, fall back to the cached shell, then
  // fall back to the offline page if even the shell isn't cached yet.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Stash a copy of the most recent navigation under the shell key
          // so the cashier gets an instant-loading dashboard on next visit.
          const cache = await caches.open(SHELL_CACHE);
          cache.put(SHELL_URL, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(SHELL_URL);
          if (cached) return cached;
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
          return new Response("Offline", { status: 503, statusText: "Offline" });
        }
      })()
    );
    return;
  }

  // Static assets: cache-first, with background fill on miss.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          if (fresh.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          return new Response("", { status: 503, statusText: "Offline" });
        }
      })()
    );
  }
});

// Allow the client side to ask the SW to skip waiting (used by the update
// banner once Slice 9 follow-up lands).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
