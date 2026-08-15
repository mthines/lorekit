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
import { withReadFields } from './entry-fields.mjs';

// Drop undefined/null args so JSON payloads stay tidy.
function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * A read that could not be answered — a transport failure or a non-2xx status,
 * as opposed to "the lesson is not there".
 *
 * Exported so a caller can tell it from a programming error and degrade
 * per-entry (report this one, keep going) instead of aborting a whole run.
 * `result` carries the raw store envelope for the message the caller shows.
 */
export class StoreReadError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'StoreReadError';
    this.result = result;
  }
}

// An absolute `expires_at` expressed as the hosted write's relative `ttl_days`.
//
// Three outcomes, and the third exists because "no expiry" and "I cannot tell"
// must not collapse into one answer:
//
//   `undefined`  no expiry — the caller states that positively with
//                `clear_ttl: true`, so a permanent lesson stops being expiring.
//   `'expired'`  already elapsed; the caller must refuse (see `putEntry`).
//   `'unknown'`  an unparseable value. The caller then sends NEITHER TTL field,
//                leaving the RPC on its `'keep'` branch, because the safe
//                reading of a corrupt frontmatter field is "do not touch the
//                expiry" — the same fail-safe posture as `isExpired`. Treating
//                it as no expiry would let one bad character wipe a live remote
//                TTL.
//
//   else         the remaining WHOLE days, clamped to the schema's 1–365.
function remoteTtlDays(expiresAt, now = new Date()) {
  if (!expiresAt) return undefined;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return 'unknown';
  const remaining = ms - now.getTime();
  if (remaining <= 0) return 'expired';
  return Math.min(365, Math.max(1, Math.ceil(remaining / 86_400_000)));
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

  async list({ scope, tags, kind, host, limit, cursor, created_since, created_until, key_prefix } = {}) {
    const p = new URLSearchParams();
    if (scope) p.set('scope', scope);
    if (tags?.length) p.set('tags', Array.isArray(tags) ? tags.join(',') : tags);
    if (kind) p.set('kind', Array.isArray(kind) ? kind.join(',') : kind);
    if (host) p.set('host', Array.isArray(host) ? host.join(',') : host);
    if (limit) p.set('limit', String(limit));
    if (cursor) p.set('cursor', cursor);
    if (created_since) p.set('created_since', created_since);
    if (created_until) p.set('created_until', created_until);
    if (key_prefix) p.set('key_prefix', key_prefix);
    const res = await this._rest(`/memories?${p}`);
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    const data = res.data ?? {};
    return {
      ok: true,
      // `withReadFields` is additive — every key the route returned survives —
      // so this projection costs existing callers nothing and gives a ranker
      // the same `seenCount`/`updatedAt` pair the local store answers with.
      entries: (data.entries ?? []).map(withReadFields),
      hasMore: data.hasMore ?? false,
      nextCursor: data.nextCursor ?? null,
    };
  }

  // `timeoutMs` is optional and defaults to `restFetch`'s own budget, so every
  // existing caller is unaffected. It exists for the callers on a user's
  // critical path, which would rather answer nothing than stall (see
  // `PROMPT_FETCH_TIMEOUT_MS` in `core/lessons.mjs`).
  async search({ q, scopes, tags, limit, cursor, timeoutMs } = {}) {
    // A list of terms collapses into ONE `websearch` query joined by `OR`, so a
    // multi-term failure lookup is a single round-trip (the server FTS ORs them
    // and stems each). `failureQuery` distils terms to `[a-z0-9]+` tokens, so no
    // FTS metacharacter reaches the query string. A plain string passes through.
    const query = Array.isArray(q) ? q.filter(Boolean).join(' OR ') : q;
    const body = {};
    if (query) body.q = query;
    if (scopes?.length) body.scopes = scopes;
    if (tags?.length) body.tags = tags;
    if (limit) body.limit = limit;
    if (cursor) body.cursor = cursor;
    const res = await this._rest('/memories/search', { method: 'POST', body, timeoutMs });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    const data = res.data ?? {};
    return {
      ok: true,
      entries: (data.entries ?? []).map(withReadFields),
      hasMore: data.hasMore ?? false,
      nextCursor: data.nextCursor ?? null,
    };
  }

  // Top-K lessons RANKED for a query — `GET /memories/relevant`.
  //
  // The difference from `search()` is the ordering, and it is the whole point:
  // search returns what MATCHES (ordered `updated_at desc` by the handler),
  // this returns what is worth READING, scored on recency + salience +
  // relevance by the same ranking the SessionStart hook applies. It answers in
  // a compact index — scope, key, a one-line hook, the score — never full
  // bodies, so a caller pays for the shortlist and fetches only what it wants.
  //
  // `scopes` is ordered MOST-SPECIFIC FIRST and that order is meaningful: the
  // server uses it to break ties, so passing `deriveScope().readOrder` verbatim
  // gives a project lesson precedence over the global one it ties with.
  //
  // Returns the store's standard `{ ok, entries }` envelope so a caller can
  // treat it like any other read, plus `candidates` — how many the FTS matched
  // before ranking — so it can say "3 of 47" rather than implying it saw
  // everything.
  async relevant({ q, scopes, limit, minScore } = {}) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (scopes?.length) p.set('scopes', Array.isArray(scopes) ? scopes.join(',') : scopes);
    if (limit) p.set('limit', String(limit));
    if (minScore != null) p.set('min_score', String(minScore));
    const res = await this._rest(`/memories/relevant?${p}`);
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    const data = res.data ?? {};
    return {
      ok: true,
      entries: Array.isArray(data.entries) ? data.entries : [],
      candidates: Number(data.candidates) || 0,
    };
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
    // Same projection as list/search — a single read must not answer with a
    // different shape than the listing the caller found the key in.
    return { ok: true, entry: entries[0] ? withReadFields(entries[0]) : null };
  }

  async write(args = {}) {
    const {
      scope, key, value, tags, source_agent, trigger, kind, host, org, ttl_days, clear_ttl, created_at,
      origin_repo, origin_branch, origin_commit, origin_pr,
    } = args;
    const body = { scope, key, value };
    if (tags !== undefined) body.tags = tags;
    if (source_agent !== undefined) body.source_agent = source_agent;
    if (trigger !== undefined) body.trigger = trigger;
    if (kind !== undefined) body.kind = kind;
    if (host !== undefined) body.host = host;
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
    // `httpStatus` and `retryAfter` are passed through so a caller can tell the
    // two 429s apart and honour the server's own backoff. They are DIFFERENT
    // failures wearing one status code: `code: 'rate_limited'` is transient and
    // must be retried, `code: 'memory_cap'` is terminal (translateDbError maps
    // the LK001 cap trigger to 429 as well) and must not be. Additive — the
    // existing `{ ok, error, networkError }` keys are unchanged.
    // Every field is coalesced, not just the retry hint: a caller comparing
    // `httpStatus` must not get `null` from a refusal and `undefined` from the
    // network-error or `unusable` branch, which is the exact split the shape
    // exists to remove.
    return {
      ok: res.ok,
      error: res.error ?? null,
      httpStatus: res.httpStatus ?? null,
      retryAfter: res.retryAfter ?? null,
      networkError: res.networkError ?? null,
    };
  }

  // ── Migrate-destination parity with LocalStore ────────────────────────────
  //
  // `migrate` classifies each source entry ADD / UPDATE / NOOP with a read and
  // then upserts it, against whatever store it was handed. LocalStore answers
  // that with `getEntry` + `putEntry`; these are the remote halves, so the
  // migrate loop stays ONE code path instead of branching per destination.
  //
  // The local pair is lossless (`putEntry` writes every field verbatim,
  // archived rows included). The remote pair CANNOT be, because the hosted
  // write is an RPC with a fixed parameter list, not a file write:
  //
  //   preserved  scope, key, value, tags, source_agent, trigger, origin_*,
  //              and `created` — sent as `created_at`, which memory_write
  //              honours on INSERT only, so a migrated lesson keeps its
  //              original creation date and its ranking recency with it.
  //   re-stamped `updated` — the server sets it to the write instant. There is
  //              no parameter for it, and inventing one would let a client
  //              backdate an edit it did not make.
  //   derived    `seen_count` — the RPC owns the tally (migration 00059: a
  //              write against an existing key IS the next sighting). A
  //              migrated lesson therefore lands at 1 and counts up from
  //              there; its local history does not transfer.
  //   converted  `expires_at` → `ttl_days`, the remaining whole days, clamped
  //              to the schema's 1–365 (a longer-lived TTL is clamped, not
  //              dropped — the alternative is silently making it permanent).
  //              A PERMANENT entry sends `clear_ttl: true` rather than simply
  //              omitting `ttl_days`: omission is the RPC's `'keep'` branch
  //              (migration 00031), which leaves an existing remote
  //              `expires_at` in place, so a permanent local lesson would
  //              land on an expiring remote row and still die.
  //
  // Two states have no remote representation at all and are REFUSED rather
  // than silently rewritten, because writing them would resurrect a lesson the
  // user retired: an archived entry (the REST write revives on conflict) and
  // an already-expired one (any `ttl_days` re-dates it into the future). Both
  // come back as `{ ok:false, unsupported }` so the caller can report them as
  // skipped; `migrate` filters them out before ever calling this.

  // Raw lookup by scope+key, mirroring `LocalStore.getEntry` — the entry or
  // null. LocalStore's is synchronous and this one cannot be, so callers must
  // `await` it; awaiting the local store's plain return value is a no-op.
  //
  // One semantic difference the caller has to know about: LocalStore.getEntry
  // sees archived rows and this cannot — `GET /memories` filters them out — so
  // a remote destination classifies an archived counterpart as ADD, and the
  // write then revives it. That is the same thing the hosted `memory_write`
  // does for any write against an archived key, not a migrate-specific quirk.
  //
  // A FAILED read THROWS rather than answering null. Null is the answer to "no
  // such lesson", and a caller that classifies ADD / UPDATE / NOOP acts on it:
  // returning null for a transient 500 or a dropped connection would quietly
  // reclassify an existing hosted lesson as new and overwrite it. The local
  // store never throws here (a file read that fails is genuinely a miss), so
  // this widens the contract only where the failure mode exists.
  async getEntry({ scope, key } = {}) {
    const res = await this.read({ scope, key });
    if (!res.ok) {
      const reason = res.networkError || res.error?.message || 'read failed';
      throw new StoreReadError(`remote read failed for ${scope}::${key}: ${reason}`, res);
    }
    return res.entry ?? null;
  }

  // Upsert one entry, as close to verbatim as the hosted write allows. See the
  // fidelity table above for exactly which fields survive. Always returns the
  // full `{ ok, error, httpStatus, retryAfter, networkError }` envelope `write`
  // returns — a refusal fills the transport fields with null rather than
  // omitting them, so a caller reading `retryAfter` never gets `undefined` from
  // one branch and `null` from another — plus `unsupported` on a refusal.
  async putEntry(entry = {}, { now = new Date() } = {}) {
    const refuse = (unsupported, message) => ({
      ok: false,
      unsupported,
      error: { message },
      httpStatus: null,
      retryAfter: null,
      networkError: null,
    });
    if (entry?.archived_at) {
      return refuse('archived', 'archived entries cannot be written remotely — the hosted write revives them');
    }
    const ttl = remoteTtlDays(entry?.expires_at, now);
    if (ttl === 'expired') {
      return refuse('expired', 'expired entries cannot be written remotely — any TTL would re-date them into the future');
    }
    return this.write(stripUndefined({
      scope: entry.scope,
      key: entry.key,
      value: entry.value == null ? '' : String(entry.value),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      source_agent: entry.source_agent,
      trigger: entry.trigger,
      created_at: entry.created,
      // `'unknown'` sends neither field, leaving the RPC on its `'keep'`
      // branch. A real TTL sends only `ttl_days`; no TTL says so explicitly
      // with `clear_ttl` rather than by omission — see the fidelity note above.
      ttl_days: typeof ttl === 'number' ? ttl : undefined,
      clear_ttl: ttl === undefined ? true : undefined,
      origin_repo: entry.origin_repo,
      origin_branch: entry.origin_branch,
      origin_commit: entry.origin_commit,
      origin_pr: entry.origin_pr,
    }));
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
  // is not relied upon (the server sorts by count desc; the view re-sorts by
  // scope type). Failures use this store's standard `{ ok:false, error,
  // networkError }` envelope so the caller can degrade gracefully.
  //
  // `httpStatus` is carried through VERBATIM from `restFetch`, which is the ONLY
  // place the real status lives: its error object holds `{ message, code }`,
  // where `code` is the response body's own application code on a JSON error
  // (a string like `permission_denied`) and only incidentally the status on a
  // non-JSON one. A consumer that wants to say "HTTP 403" must therefore read
  // `httpStatus`, never `error.code` — `store/scope-inventory.mjs`'s
  // `failureReason` does exactly that, and it had nothing to read until this field was passed
  // through. Additive: `scopes.mjs`, `stats.mjs` and `lessons-view.mjs` all
  // branch on `ok` / `unusable` / `networkError` and ignore the extra key.
  async listScopes() {
    const res = await this._rest('/memories/scopes');
    if (!res.ok) {
      return {
        ok: false,
        error: res.error,
        httpStatus: res.httpStatus,
        networkError: res.networkError,
        unusable: res.unusable,
      };
    }
    const scopes = Array.isArray(res.data?.scopes) ? res.data.scopes : [];
    // `last_activity` (migration 00049) is `max(created_at)` over exactly the
    // counted rows — per-scope freshness without listing rows to reduce them,
    // which is the row-cap trap this endpoint exists to avoid. It is passed
    // through when present and OMITTED when absent (an older backend, or the
    // offline store, which has no equivalent), so a consumer can tell "this
    // store does not report freshness" from "this scope has none". Callers that
    // read only `{ scope, count }` — `scopes.mjs`, `stats.mjs` — are unaffected.
    return {
      ok: true,
      scopes: scopes.map((s) => ({
        scope: s.scope,
        count: Number(s.count) || 0,
        ...(s.last_activity ? { last_activity: s.last_activity } : {}),
      })),
    };
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
  //   429 → rate limited, and it says NOTHING about the credential. The only
  //         `tooManyRequests()` call sites on the whole REST surface are
  //         `memories/handlers/create.ts` and `purge.ts` — both write paths.
  //         `GET /memories` (`handleList`) has no rate-limit check at all, so a
  //         429 here is emitted by the platform edge AHEAD of the function,
  //         before `resolveRestAuth` ever runs. `rateLimited` is still reported
  //         so the caller can say "retry shortly" instead of "inconclusive".
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
      return { ok: true, authenticated: null, permitted: null, rateLimited: true, httpStatus, error: res.error };
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
