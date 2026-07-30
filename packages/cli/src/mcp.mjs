// Minimal MCP-over-HTTP (JSON-RPC 2.0) client for the LoreKit endpoint.
// Zero dependencies — uses the global fetch (Node 18+).

// Split a configured server URL like ".../mcp?token=lk_rw_x" into
// { endpoint: ".../mcp", token: "lk_rw_x" }.
export function splitEndpoint(url) {
  if (!url) return { endpoint: null, token: null };
  try {
    const u = new URL(url);
    const token = u.searchParams.get('token');
    u.searchParams.delete('token');
    const endpoint = u.origin + u.pathname + (u.search || '');
    return { endpoint, token: token || null };
  } catch {
    return { endpoint: url, token: null };
  }
}

// Build the mcp-remote URL that goes into .mcp.json args.
export function buildRemoteUrl(endpoint, token) {
  if (!token) return endpoint;
  const u = new URL(endpoint);
  u.searchParams.set('token', token);
  return u.toString();
}

let idCounter = 0;

// Returns { ok, httpStatus, result, error, networkError }.
export async function mcpCall(endpoint, token, method, params = {}, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Inside the try so a malformed endpoint yields the documented
    // { ok:false, networkError } shape instead of throwing at the call site.
    const url = buildRemoteUrl(endpoint, token);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params }),
      signal: controller.signal,
    });

    const text = await res.text();
    const json = parseBody(text);

    if (json && json.error) {
      return { ok: false, httpStatus: res.status, error: json.error };
    }
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error: { code: res.status, message: text.slice(0, 200) || res.statusText },
      };
    }
    return { ok: true, httpStatus: res.status, result: json ? json.result : undefined };
  } catch (e) {
    return { ok: false, networkError: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

// The endpoint may answer as plain JSON or as an SSE frame ("data: {...}").
function parseBody(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const line = trimmed
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (line) {
      try {
        return JSON.parse(line.slice('data:'.length).trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Derive the REST API base URL from an MCP endpoint URL.
 * e.g. 'https://ref.supabase.co/functions/v1/mcp?token=...'
 *   → 'https://ref.supabase.co/functions/v1'
 */
export function mcpToRestBase(mcpEndpointUrl) {
  if (!mcpEndpointUrl) return null;
  try {
    const u = new URL(mcpEndpointUrl);
    u.searchParams.delete('token');
    // Strip /mcp suffix (with or without trailing slash)
    const restPath = u.pathname.replace(/\/mcp\/?$/, '');
    return `${u.origin}${restPath || '/'}`;
  } catch {
    return null;
  }
}

/**
 * Minimal REST fetch for LoreKit REST API endpoints.
 * Returns { ok, httpStatus, data, error, networkError } — same shape as mcpCall.
 *
 * @param {string} baseUrl - REST base URL (from mcpToRestBase)
 * @param {string} token   - Bearer token
 * @param {string} path    - e.g. '/memories' or '/memories/search'
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.body] - JSON body for POST/PATCH/DELETE
 * @param {number} [opts.timeoutMs=10000]
 * @param {string} [opts.traceparent] - W3C traceparent header value
 */
export async function restFetch(baseUrl, token, path, { method = 'GET', body, timeoutMs = 10000, traceparent } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl}${path}`;
    const headers = {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(traceparent ? { traceparent } : {}),
    };
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error: data?.error ? { message: data.error, code: data.code } : { code: res.status, message: text.slice(0, 200) || res.statusText },
      };
    }
    return { ok: true, httpStatus: res.status, data };
  } catch (e) {
    return { ok: false, networkError: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
