// BYOD ("bring your own database") storage probe — one PostgREST round-trip
// that says whether a Supabase project is reachable and holds the LoreKit
// schema. Shared by `lorekit doctor` and `lorekit bootstrap`.
//
// Zero-dependency on purpose. Both callers used to `import('@supabase/supabase-js')`,
// which the published CLI does not ship (it has no dependencies), so for every
// npm install the probe failed before sending a request and `doctor` reported
// "could not connect" whatever state the database was in. PostgREST is plain
// HTTP; `fetch` is all it needs.

const DEFAULT_TIMEOUT_MS = 10_000;

// PostgREST's answer for a table it cannot see. 42P01 is Postgres's
// undefined_table, surfaced by older PostgREST; PGRST205 is the schema-cache
// miss newer PostgREST returns for the same situation.
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

/**
 * Probe a BYOD Supabase project.
 * @param {{ url: string, key: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<{ state: 'ready' } | { state: 'no-schema', detail: string } | { state: 'error', detail: string }>}
 *   ready      — reachable, and the `memories` table answers
 *   no-schema  — reachable, but the LoreKit schema has not been applied
 *   error      — unreachable, rejected the key, or answered unexpectedly
 */
export async function probeByodStorage({ url, key, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let endpoint;
  try {
    endpoint = new URL('rest/v1/memories?select=id&limit=1', url.endsWith('/') ? url : `${url}/`);
  } catch {
    return { state: 'error', detail: `not a valid URL: ${url}` };
  }

  let res;
  try {
    res = await fetchImpl(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { state: 'error', detail: `could not connect: ${e && e.message ? e.message : String(e)}` };
  }

  if (res.ok) return { state: 'ready' };

  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body (a proxy page, an HTML 502): reported by status alone.
  }
  if (body && MISSING_TABLE_CODES.has(body.code)) {
    return { state: 'no-schema', detail: 'connected, but the LoreKit schema is not applied' };
  }
  const message = body && body.message ? `: ${body.message}` : '';
  return { state: 'error', detail: `HTTP ${res.status}${message}` };
}
