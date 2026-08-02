// Remote store: wraps the LoreKit REST API behind the common store contract.
// EVERY operation this store performs goes over REST — memory list, search,
// read, write, delete (soft-archive AND `?force=true` hard-delete), the
// store-wide `listScopes()` enumeration, all four `org.*` operations, and the
// `ping` connectivity probe. There is NO MCP transport left here: the store
// imports `restFetch`/`mcpToRestBase` and nothing else.
//
// Org ops used to be the one holdout. The org RPCs resolved their actor from
// `auth.uid()`, which is NULL on the service-role connection an `lk_*` api_key
// token gets, so `/orgs` 403'd every CLI caller and the store had to keep a
// JSON-RPC transport alive purely for `org.create`/`org.list`/`org.rename`/
// `org.delete`. `00041_org_actor_override.sql` added a `p_actor_user_id`
// override that the RPCs honour only on a verified service_role connection,
// and the `orgs` edge function now passes it plus its own tenant filters — so
// every `/orgs*` route serves api_key tokens and the holdout is gone.
//
// `packages/cli/src/mcp.mjs` still exists and is still used: it backs the
// `lorekit mcp` stdio server command and provides `mcpToRestBase`. It is just
// no longer a transport for this store.
// Zero-dependency.
import { restFetch, mcpToRestBase } from '../mcp.mjs';
import { getActiveTraceparent } from '../telemetry.mjs';

// Drop undefined/null args so JSON payloads stay tidy.
function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export function createRemoteStore({ endpoint, token } = {}) {
  return new RemoteStore(endpoint, token);
}

class RemoteStore {
  constructor(endpoint, token) {
    // The configured endpoint is still spelled as the `/mcp` URL (that is what
    // `.mcp.json` / LOREKIT_MCP_URL hold, and changing that config key is a
    // separate migration). Nothing here speaks MCP: it exists only so
    // `usable()` can judge the configuration and `mcpToRestBase` can derive the
    // REST base from it.
    this.endpoint = endpoint;
    this.token = token;
    this.restBase = mcpToRestBase(endpoint); // REST base URL for memory ops
    this.mode = 'remote';
  }

  usable() {
    return Boolean(this.endpoint && this.token && !String(this.endpoint).includes('<project-ref>'));
  }

  _tp() { return getActiveTraceparent(); }

  async _rest(path, opts = {}) {
    if (!this.usable()) return { ok: false, unusable: true };
    return restFetch(this.restBase, this.token, path, { ...opts, traceparent: this._tp() });
  }

  // ── Memory operations → REST ──────────────────────────────────────────────

  async list({ scope, tags, limit } = {}) {
    const p = new URLSearchParams();
    if (scope) p.set('scope', scope);
    if (tags?.length) p.set('tags', Array.isArray(tags) ? tags.join(',') : tags);
    if (limit) p.set('limit', String(limit));
    const res = await this._rest(`/memories?${p}`);
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    return { ok: true, entries: res.data?.entries ?? [] };
  }

  async search({ q, scopes, tags } = {}) {
    const body = {};
    if (q) body.q = q;
    if (scopes?.length) body.scopes = scopes;
    if (tags?.length) body.tags = tags;
    const res = await this._rest('/memories/search', { method: 'POST', body });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    return { ok: true, entries: res.data?.entries ?? [] };
  }

  async read({ scope, key } = {}) {
    const p = new URLSearchParams();
    if (scope) p.set('scope', scope);
    if (key) p.set('key', key);
    // scope+key is unique, so one row is all there can be — don't pull the default page of 50.
    p.set('limit', '1');
    const res = await this._rest(`/memories?${p}`);
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    const entries = res.data?.entries ?? [];
    return { ok: true, entry: entries[0] ?? null };
  }

  async write(args = {}) {
    const {
      scope, key, value, tags, source_agent, trigger, org, ttl_days, clear_ttl, created_at,
      origin_repo, origin_branch, origin_commit, origin_pr,
    } = args;
    const body = { scope, key, value };
    if (tags !== undefined) body.tags = tags;
    if (source_agent !== undefined) body.source_agent = source_agent;
    if (trigger !== undefined) body.trigger = trigger;
    if (org !== undefined) body.org = org;
    if (ttl_days !== undefined) body.ttl_days = ttl_days;
    if (clear_ttl !== undefined) body.clear_ttl = clear_ttl;
    if (created_at !== undefined) body.created_at = created_at;
    // Provenance — only sent when known. Omitting a field leaves whatever the
    // row already recorded intact (the RPC coalesces), which is what makes a
    // write from a machine with no git context non-destructive.
    if (origin_repo !== undefined) body.origin_repo = origin_repo;
    if (origin_branch !== undefined) body.origin_branch = origin_branch;
    if (origin_commit !== undefined) body.origin_commit = origin_commit;
    if (origin_pr !== undefined) body.origin_pr = origin_pr;
    const res = await this._rest('/memories', { method: 'POST', body });
    return { ok: res.ok, error: res.error, networkError: res.networkError };
  }

  // Natural-key DELETE. Without `force` the server soft-archives (stamps
  // `archived_at`); `?force=true` hard-deletes the row outright — both forms of
  // the same REST route (supabase/functions/memories/handlers/remove.ts).
  async delete({ scope, key, force = false } = {}) {
    const p = new URLSearchParams({ scope, key });
    if (force) p.set('force', 'true');
    const res = await this._rest(`/memories?${p}`, { method: 'DELETE' });
    return { ok: res.ok, error: res.error, networkError: res.networkError };
  }

  async archive({ scope, key } = {}) {
    // Soft-archive = DELETE without force
    return this.delete({ scope, key, force: false });
  }

  // ── Org operations → REST ─────────────────────────────────────────────────
  // `supabase/functions/orgs/` serves `lk_*` tokens on every route as of
  // 00041_org_actor_override.sql (see the file header). Each method's RETURN
  // SHAPE is unchanged from the MCP era — `packages/cli/src/mcp-server.mjs`
  // serialises these objects straight into a `tools/call` result, so the shape
  // is a published contract, not an internal detail.
  //
  // Slugs are interpolated into the PATH, so they must be encodeURIComponent'd.
  // A slug is server-side constrained to `[a-z0-9-]`, but the CLI passes
  // whatever the user typed and an un-encoded `../` or `?` would retarget the
  // request at a different route entirely.

  // POST /orgs → 201 with the created org object, `{ id, slug, name, created_at }`.
  // The handler reads the row back after the RPC (`orgs/handlers/orgs/create.ts`);
  // `created_at` is absent only on the read-back miss, where it falls back to
  // `{ id, slug, name }`. A bare JSON id string is the LEGACY shape an older
  // deployed backend can still return — that is what the string branch below is
  // for, not the normal case. Either way this method reassembles the
  // `{ id, slug, name }` triple, because `packages/cli/src/mcp-server.mjs`
  // serialises it straight into a `tools/call` result and that shape is a
  // published contract.
  async orgCreate({ slug, name } = {}) {
    const res = await this._rest('/orgs', { method: 'POST', body: { slug, name } });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    const id = typeof res.data === 'string' ? res.data : (res.data?.id ?? null);
    return { ok: true, org: { id, slug, name } };
  }

  // GET /orgs → { entries: [{ id, slug, name, role, created_at }] }
  async orgList() {
    const res = await this._rest('/orgs');
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    return { ok: true, entries: Array.isArray(res.data?.entries) ? res.data.entries : [] };
  }

  // PATCH /orgs/:slug → 200 { slug, name }
  async orgRename({ slug, name } = {}) {
    const res = await this._rest(`/orgs/${encodeURIComponent(slug)}`, { method: 'PATCH', body: { name } });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    return { ok: true, ...(res.data ?? { slug, name }) };
  }

  // DELETE /orgs/:slug → 204 with no body, so `deleted: true` is synthesised to
  // preserve the `{ ok, deleted, slug }` shape the MCP tool returned.
  async orgDelete({ slug } = {}) {
    const res = await this._rest(`/orgs/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    return { ok: true, deleted: true, slug };
  }

  // Store-wide scope enumeration — every distinct scope the caller can see with
  // its count of active (non-archived, non-expired) memories. `GET
  // /memories/scopes` aggregates in Postgres, so the answer is exact at any size
  // (see supabase/functions/memories/handlers/scopes.ts).
  //
  // The `scopes` array is the SAME `[{ scope, count }]` inventory shape
  // `LocalStore.listScopes()` returns, so `scopes.mjs` feeds both through the
  // same pure `filterScopeInventory`/`summarizeScopeInventory` helpers. Ordering
  // is not relied upon (the server sorts by scope asc; the view re-sorts by
  // scope type). Failures use this store's standard `{ ok:false, error,
  // networkError }` envelope so the caller can degrade gracefully.
  async listScopes() {
    const res = await this._rest('/memories/scopes');
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError, unusable: res.unusable };
    const scopes = Array.isArray(res.data?.scopes) ? res.data.scopes : [];
    return { ok: true, scopes: scopes.map((s) => ({ scope: s.scope, count: Number(s.count) || 0 })) };
  }

  // Authentication probe for doctor — does the configured token STILL work?
  //
  // `ping()` deliberately hits the PUBLIC `/health` function, so it stays green
  // for a revoked, deleted or mistyped token: it proves the network path, and
  // nothing about the credential. This probe is the missing half. It makes one
  // authenticated, side-effect-free request (`GET /memories?limit=1`) and
  // classifies the answer:
  //
  //   200 → the token was accepted AND may read.
  //   401 → the token was REJECTED (revoked, deleted, or never valid). This is
  //         `resolveRestAuth` finding no `api_tokens` row for the hash
  //         (supabase/functions/_shared/api/auth.ts).
  //   403 → the token was ACCEPTED, but lacks read permission — the normal,
  //         healthy answer for a write-only `lk_wo_*` token, so it must never
  //         be reported as an auth failure.
  //   429 → rate limited. The request never reached the route, but it DID get
  //         past auth, so the token is live.
  //
  // Returns { ok, authenticated, permitted, rateLimited, httpStatus, error,
  // networkError, unusable }. `authenticated` is null when the answer does not
  // settle the question — the caller must not turn "don't know" into "broken".
  async verifyAuth() {
    if (!this.usable()) return { ok: false, unusable: true, authenticated: null };
    if (!this.restBase) {
      return { ok: false, authenticated: null, error: { message: `Endpoint is not a valid URL: ${this.endpoint}` } };
    }
    // limit=1 keeps the probe cheap; the rows themselves are never read.
    const res = await this._rest('/memories?limit=1');
    if (res.networkError) return { ok: false, authenticated: null, networkError: res.networkError };
    if (res.ok) return { ok: true, authenticated: true, permitted: true, httpStatus: res.httpStatus };

    const httpStatus = res.httpStatus ?? null;
    if (httpStatus === 401) {
      return { ok: false, authenticated: false, permitted: false, httpStatus, error: res.error };
    }
    if (httpStatus === 403) {
      return { ok: true, authenticated: true, permitted: false, httpStatus, error: res.error };
    }
    if (httpStatus === 429) {
      return { ok: true, authenticated: true, permitted: null, rateLimited: true, httpStatus, error: res.error };
    }
    return { ok: false, authenticated: null, httpStatus, error: res.error };
  }

  // Connectivity probe for doctor — a transport check, not a memory op.
  //
  // NOTE: this is deliberately UNAUTHENTICATED (the `/health` function is
  // public), so a green result says the endpoint is reachable and says NOTHING
  // about the token. `verifyAuth()` above is what answers that; doctor runs
  // both and reports them as separate checks.
  //
  // There is no MCP fallback: a `restBase` we could not derive means the
  // configured endpoint is not a URL, and a JSON-RPC POST to that same
  // unparseable string could only fail in a less legible way. Report the
  // configuration problem instead.
  async ping() {
    if (!this.usable()) return { ok: false, unusable: true };
    // Use the /health function as a connectivity probe (public, no auth)
    if (!this.restBase) {
      return { ok: false, error: { message: `Endpoint is not a valid URL: ${this.endpoint}` } };
    }
    const healthUrl = `${this.restBase.replace(/\/functions\/v1$/, '')}/functions/v1/health`;
    const tp = this._tp();
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5000),
        ...(tp ? { headers: { traceparent: tp } } : {}),
      });
      return { ok: res.ok, httpStatus: res.status };
    } catch (e) { return { ok: false, networkError: String(e?.message ?? e) }; }
  }
}
