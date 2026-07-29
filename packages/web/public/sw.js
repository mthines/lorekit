/**
 * LoreKit Service Worker
 *
 * Strategy: network-first for all navigation requests (always fresh HTML from
 * the server), cache-first for static assets (JS/CSS/fonts/images).
 *
 * Keeps the install prompt working on HTTPS / localhost without breaking
 * Next.js's own asset cache-busting (which uses content-hashed filenames).
 *
 * ## Cache version — bump when response headers change
 *
 * The SW caches full HTTP responses, including their headers. When a server-side
 * header is added (e.g. Access-Control-Allow-Origin on /_next/static/*), existing
 * devices keep serving the OLD cached copy that lacks the header — the new header
 * never reaches the browser. Bumping CACHE_VERSION forces the activate handler to
 * delete the old cache so all cached responses are replaced on next access.
 *
 * CACHE_VERSION was bumped from v1 → v2 when Access-Control-Allow-Origin: * was
 * added to /_next/static/:path* in next.config.ts. Without this bump, iPhone
 * Safari users would continue to see opaque "Script error." at 0:0 (cross-origin
 * error suppression) even after the server-side CORS fix was deployed.
 */

const CACHE_VERSION = 'v2';
const STATIC_CACHE = `lorekit-static-${CACHE_VERSION}`;
const SHELL_CACHE = `lorekit-shell-${CACHE_VERSION}`;

/** Patterns for resources that should be served cache-first. */
const STATIC_PATTERNS = [
  /\/_next\/static\//,   // Next.js hashed JS/CSS chunks
  /\/fonts\//,
  /\/icons\//,
  /\/screenshots\//,
];

/** App-shell pages to pre-cache on install. */
const SHELL_URLS = ['/'];

// ─── Install ───────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

// ─── Activate ──────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  const keep = [STATIC_CACHE, SHELL_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// ─── Fetch ─────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  // Skip non-GET and API/auth routes — always go to the network.
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  const isStatic = STATIC_PATTERNS.some((re) => re.test(url.pathname));

  if (isStatic) {
    // Cache-first: return cached asset immediately; update in background.
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
  } else {
    // Network-first: try the network; fall back to cached shell on failure.
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful navigation responses for offline fallback.
          if (response.ok && request.mode === 'navigate') {
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) =>
              cached ??
              caches.match('/').then(
                (shell) => shell ?? Response.error(),
              ),
          ),
        ),
    );
  }
});
