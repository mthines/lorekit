// `node:http` server plumbing for `lorekit serve`'s local REST shim — request
// parsing, CORS, and the `{ error, code }` 404 envelope. All ROUTING and STORE
// access live in `routes.mjs`; this module only turns an `http.IncomingMessage`
// into the plain `(method, pathname, query, body)` tuple `routes.mjs` expects,
// and turns its `{ status, headers, body }` back into a real HTTP response.
//
// Zero-dependency: `node:http` + `node:url` only — no express, no body-parser.
//
// Auth (D3/R8): this shim is LOCAL-ONLY (bound to 127.0.0.1 by `serve.mjs`)
// and accepts any or no `Authorization` header as one implicit local user —
// `dashboard`'s `restFetch` always sends a Bearer token, but its value is
// never inspected. There is no real user/JWT/RLS locally.
import http from 'node:http';

const BASE_PATH = '/functions/v1';

/**
 * CORS: reflect the requesting Origin (so the dashboard, served from its own
 * dev-server port, can call this shim) and the exact request headers the
 * dashboard's REST client sends (`Authorization`, `Content-Type`,
 * `X-LoreKit-Client`, `traceparent`, `tracestate`) plus every method the route
 * table uses.
 */
function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-LoreKit-Client, traceparent, tracestate',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Build a `node:http` server over one `dispatch(method, pathname, query,
 * body)` function (see `createRoutes` in `routes.mjs`).
 *
 * `basePath` defaults to `/functions/v1`, matching `restBaseUrl()`'s
 * `${NEXT_PUBLIC_SUPABASE_URL}/functions/v1` contract — the dashboard's REST
 * client is pointed at this shim by setting `NEXT_PUBLIC_SUPABASE_URL` to this
 * server's own origin, so a request it makes to `/memories/scopes` arrives
 * here as `/functions/v1/memories/scopes`.
 */
export function createShimServer(dispatch, { basePath = BASE_PATH } = {}) {
  return http.createServer((req, res) => {
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    let pathname = url.pathname;
    if (!pathname.startsWith(basePath)) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Route not found', code: 'not_found' }));
      return;
    }
    pathname = pathname.slice(basePath.length) || '/';

    const query = Object.fromEntries(url.searchParams.entries());

    const respond = ({ status, headers = {}, body }) => {
      res.writeHead(status, { ...cors, ...headers });
      res.end(body);
    };

    const run = async () => {
      let body;
      if (req.method === 'POST' || req.method === 'PATCH') {
        body = parseJsonBody(await readBody(req));
      }
      return dispatch(req.method, pathname, query, body);
    };

    run().then(respond).catch((err) => {
      // A handler fault must not crash the server — mirror the edge
      // function's `internalError` envelope rather than hanging the request.
      // eslint-disable-next-line no-console
      console.error('[lorekit serve] request error:', err);
      respond({ status: 500, body: JSON.stringify({ error: 'Internal server error', code: 'internal_error' }) });
    });
  });
}
