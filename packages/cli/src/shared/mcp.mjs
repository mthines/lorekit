// Minimal MCP-over-HTTP (JSON-RPC 2.0) client for the LoreKit endpoint.
// Zero EXTERNAL dependencies — uses the global fetch (Node 18+). Imports
// below are same-package sibling modules (`./origin.mjs`), not npm deps.

import { prNumberFromEnv, isValidRepo } from './origin.mjs';

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

/**
 * Response header naming the account the request authenticated as, set by the
 * edge REST router for every non-service-role caller.
 *
 * The CLI's only way to know its own account id without a dedicated `/me`
 * round-trip: it rides along on calls the CLI was making anyway. Cached by
 * `RemoteStore._rest` so LOCAL, fully-offline runs can still report which
 * account they belong to — see `telemetry-identity.mjs`.
 *
 * Kept in step with `CALLER_USER_ID_HEADER` in
 * `supabase/functions/_shared/api/router.ts`.
 */
export const USER_ID_HEADER = 'x-lorekit-user-id';

// Returns { ok, httpStatus, result, error, networkError }.
//
// `opts.traceparent` is an optional W3C traceparent header value (see
// src/telemetry.mjs `getActiveTraceparent`); when present it is forwarded so
// the server-side span joins the CLI's trace — same idiom as restFetch.
export async function mcpCall(endpoint, token, method, params = {}, { timeoutMs = 10000, traceparent } = {}) {
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
        ...(traceparent ? { traceparent } : {}),
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
    // A tool-originated failure arrives as a SUCCESSFUL JSON-RPC result carrying
    // `isError: true` — that is the MCP spec's shape, so the model can see the
    // error and self-correct, and the edge handler now uses it for everything
    // the caller can fix (a memory-cap hit, a malformed scope, a bad TTL).
    //
    // Without this branch the check above passes (there is no `json.error`) and
    // the call is reported as `ok: true`, so a cap rejection reads as a
    // successful write. Exactly the trap the load-test driver hit from the other
    // side: on this transport the status code does not carry the outcome.
    if (json && json.result && json.result.isError) {
      const text0 = json.result.content && json.result.content[0];
      return {
        ok: false,
        httpStatus: res.status,
        toolError: true,
        error: { code: 'tool_error', message: (text0 && text0.text) || 'The tool reported an error.' },
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
/**
 * Normalise a client-supplied usage correlation id (a PR ref, session id, or CI
 * job id). Bounded + charset-restricted to match the server's `parseCorrelationId`
 * (supabase/functions/_shared/telemetry/usage-stats.ts); returns null for empty/over-long/
 * out-of-charset input so a bad value is simply not sent. Zero-dep (the CLI does
 * not import mcp-core), so the small regex is duplicated intentionally.
 */
export function normalizeCorrelationId(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 200) return null;
  return /^[A-Za-z0-9_\-./:#@]+$/.test(t) ? t : null;
}

/**
 * The bounded `session_kind` vocabulary (migration 00082) — sent via
 * `X-LoreKit-Session-Kind`, validated edge-side by the CROSS-LANGUAGE twin of
 * this file's derivation, `packages/mcp-core/src/telemetry/session-kind.ts`
 * (`parseSessionKind`). Kept here rather than imported: this package has no
 * dependency on `@lorekit/core`, and the two are guarded for behavioural
 * parity by `session-kind-parity.spec.ts` rather than a byte comparison,
 * which is what a cross-language pair (this `.mjs` vs that `.ts`) needs.
 */
const SESSION_KINDS = ['local', 'ci', 'pr', 'unknown'];

/**
 * Derive `{ correlationId, sessionKind }` from the ambient environment, for
 * every call site that does not have an EXPLICIT `LOREKIT_CORRELATION_ID` —
 * the caller checks that first and skips this entirely when it is set, since
 * an explicit value always wins.
 *
 * Precedence, first match wins:
 *   1. PR context — `prNumberFromEnv` (LOREKIT_PR / GITHUB_REF / GITHUB_PR_NUMBER,
 *      see `origin.mjs`) resolves a PR number AND a repo is known → `pr` +
 *      `pr:<owner>/<repo>#<n>`.
 *   2. CI environment (`GITHUB_ACTIONS`/`CI`) — `ci` always; a correlation id
 *      of `ci:<owner>/<repo>#<run_id>` when both a repo and GITHUB_RUN_ID are
 *      known, otherwise no correlation id (still `ci` — the session KIND is
 *      known even when a stable id to group by is not).
 *   3. A host-provided session id (`LOREKIT_SESSION_ID`, or the handful of
 *      well-known agent-host env vars below) — `local` +
 *      `session:<id>`. The raw id itself is never logged or stored anywhere
 *      beyond this derived correlation id.
 *   4. Otherwise `unknown`, no correlation id — never a guess.
 *
 * TOTAL and fail-safe: reads only `env` (never throws on a missing/odd
 * value), and every branch degrades to the next rather than throwing. A
 * derived value that fails `normalizeCorrelationId`'s charset/length check is
 * dropped (session_kind is still reported; only the drill-down id is not).
 */
export function deriveSessionContext(env = process.env) {
  const repo = isValidRepo(env.GITHUB_REPOSITORY);
  const prNumber = prNumberFromEnv(env);

  if (prNumber !== null && repo) {
    const correlationId = normalizeCorrelationId(`pr:${repo}#${prNumber}`);
    if (correlationId) return { correlationId, sessionKind: 'pr' };
  }

  const isCI = env.GITHUB_ACTIONS === 'true' || env.CI === 'true' || env.CI === '1';
  if (isCI) {
    const runId = typeof env.GITHUB_RUN_ID === 'string' ? env.GITHUB_RUN_ID.trim() : '';
    if (repo && runId) {
      const correlationId = normalizeCorrelationId(`ci:${repo}#${runId}`);
      if (correlationId) return { correlationId, sessionKind: 'ci' };
    }
    return { correlationId: null, sessionKind: 'ci' };
  }

  // Well-known agent-host session id env vars. Best-effort: hosts differ and
  // this is not an exhaustive registry, so an unrecognised host still falls
  // through to `unknown` rather than fabricating an id.
  const sessionId = firstNonEmptyEnv(env, ['LOREKIT_SESSION_ID', 'CLAUDE_SESSION_ID']);
  if (sessionId) {
    // A local session IS known even when the specific id fails the
    // correlation-id charset/length check — report the kind either way, and
    // let the id itself degrade to null rather than losing the whole reading.
    return { correlationId: normalizeCorrelationId(`session:${sessionId}`), sessionKind: 'local' };
  }

  return { correlationId: null, sessionKind: 'unknown' };
}

function firstNonEmptyEnv(env, keys) {
  for (const key of keys) {
    const v = env[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * Validate a `session_kind` value against the closed vocabulary. Total and
 * fail-safe — mirrors `parseSessionKind`'s behaviour (never used to VALIDATE
 * an incoming value here, since this process only ever sends a value it just
 * derived itself, but kept as the single place the vocabulary is spelled out
 * so `deriveSessionContext` and any future caller cannot drift from it).
 */
export function isSessionKind(value) {
  return SESSION_KINDS.includes(value);
}

/**
 * Normalise a deployment-environment marker restFetch attaches as
 * X-LoreKit-Deployment-Environment when DEPLOYMENT_ENVIRONMENT (or
 * OTEL_DEPLOYMENT_ENVIRONMENT) is set. It lets a smoke/test run tell the edge to
 * report `deployment.environment.name` for that request — the edge honours only
 * the synthetic `test` value, so real traffic (no env set) is never tagged and a
 * caller can never relabel itself as another real environment. This is the SAME
 * value `resolveDeploymentEnvironment` (packages/cli/src/telemetry.mjs) puts on
 * the CLI's own resource, so one `DEPLOYMENT_ENVIRONMENT=test` marks both the CLI
 * span and its downstream edge spans. Bounded + charset-restricted (fail-safe: a
 * bad value is not sent). Zero-dep, so the small regex is duplicated
 * intentionally, like `normalizeCorrelationId`.
 */
export function normalizeRunEnvironment(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 64) return null;
  return /^[A-Za-z0-9_.\-:]+$/.test(t) ? t : null;
}

/**
 * The retry delay a failed response advertised, in whole seconds, or null.
 *
 * Prefers the JSON body's `retryAfterSeconds` over the `Retry-After` header:
 * both are set by the same `tooManyRequests()` helper, and the body value is
 * the number the rate-limit RPC actually returned, while the header is its
 * stringified copy that an intermediary may rewrite.
 *
 * TOTAL over any input. `headers` is read through optional calls because a
 * test double (and a hand-rolled Response-alike) may not implement the Headers
 * interface, and a missing retry hint must never be able to throw on an error
 * path — the caller is already handling a failure.
 */
export function retryAfterFrom(data, headers) {
  const raw = data?.retryAfterSeconds ?? (typeof headers?.get === 'function' ? headers.get('retry-after') : null);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  // A `Retry-After` may also be an HTTP-date; a non-numeric value is reported
  // as "no hint" so the caller falls back to its own backoff rather than
  // waiting on NaN.
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.ceil(n);
}

export async function restFetch(baseUrl, token, path, { method = 'GET', body, timeoutMs = 10000, traceparent } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl}${path}`;
    // Usage correlation: an EXPLICIT LOREKIT_CORRELATION_ID always wins (e.g. a
    // CI job or a hook hand-setting a PR/session id). Otherwise, derive one
    // from the ambient environment (CI/PR/session — see `deriveSessionContext`)
    // so GET /memories/usage?correlation_id=… and the session_kind dimension
    // are populated without anyone having to export anything by hand. Both
    // stay unset only when neither an explicit value nor a derivable one
    // exists (`sessionKind: 'unknown'`, no correlationId).
    const explicitCorrelationId = normalizeCorrelationId(process.env.LOREKIT_CORRELATION_ID);
    const derived = explicitCorrelationId ? null : deriveSessionContext(process.env);
    const correlationId = explicitCorrelationId ?? derived?.correlationId ?? null;
    const sessionKind = derived?.sessionKind ?? null;
    // Opt-in test-run marker: when DEPLOYMENT_ENVIRONMENT is set (a deploy/CI
    // smoke sets it to `test`), tell the edge to report that
    // `deployment.environment.name` for this request so Dash0 can filter synthetic
    // smoke traffic apart from real usage. Absent env ⇒ no header ⇒ existing
    // behaviour unchanged. The edge honours only `test` (see otel.ts).
    const runEnv = normalizeRunEnvironment(
      process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.OTEL_DEPLOYMENT_ENVIRONMENT,
    );
    const headers = {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(traceparent ? { traceparent } : {}),
      ...(correlationId ? { 'x-lorekit-correlation-id': correlationId } : {}),
      ...(sessionKind ? { 'x-lorekit-session-kind': sessionKind } : {}),
      ...(runEnv ? { 'x-lorekit-deployment-environment': runEnv } : {}),
      // Name the calling surface so usage analytics can tell a CLI read from a
      // dashboard one. Not cosmetic: `GET /memories/read-activity` EXCLUDES the
      // `dashboard` client (a human browsing lore is not consuming it), so a
      // caller that wants its reads counted has to be attributable. Constant,
      // never env-driven — this binary is always the CLI.
      'x-lorekit-client': 'cli',
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
    // The account this call authenticated as, as the server resolved it. Read on
    // BOTH the success and failure paths: a 429 or a 404 is still an
    // authenticated request, and rate-limited traffic is exactly when knowing
    // whose it is matters most. Surfaced, not cached, here — `mcp.mjs` is in
    // `control.mjs`'s import graph (`splitEndpoint`), and the identity module
    // reads `homeRoot` from `control.mjs`, so importing it here would close an
    // import cycle. `RemoteStore._rest` — the ONE caller of this function, so
    // nothing is missed by doing it a layer out — does the caching.
    const userId = res.headers?.get?.(USER_ID_HEADER) ?? null;
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        userId,
        // How long the server asked the caller to wait, in seconds, or null when
        // it did not say. Only a 429 carries one today (`tooManyRequests` sets
        // BOTH a `retryAfterSeconds` body field and the `Retry-After` header),
        // but this is read on every failure so a future 503 needs no change
        // here. Additive: existing callers ignore the extra key.
        retryAfter: retryAfterFrom(data, res.headers),
        error: data?.error ? { message: data.error, code: data.code } : { code: res.status, message: text.slice(0, 200) || res.statusText },
      };
    }
    return { ok: true, httpStatus: res.status, data, userId };
  } catch (e) {
    return { ok: false, networkError: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
