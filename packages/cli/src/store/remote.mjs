// Remote store: wraps the LoreKit REST API `memory.*` endpoints behind the
// common store contract. Memory operations use the REST API for lower overhead
// and W3C traceparent propagation. Org operations remain on MCP because org
// RPCs require a Supabase JWT session (auth.uid() via SECURITY DEFINER
// functions), which is incompatible with the lk_* api_key tokens that CLI
// users have. Zero-dependency.
import { mcpCall, restFetch, mcpToRestBase } from '../mcp.mjs';
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
    this.endpoint = endpoint; // MCP URL (kept for org ops)
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

  async _mcp(name, args) {
    if (!this.usable()) return { ok: false, unusable: true };
    return mcpCall(this.endpoint, this.token, 'tools/call', { name, arguments: args }, { traceparent: this._tp() });
  }

  _mcpEntries(res) {
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    // MCP wraps results in { content: [{ type: 'text', text: '<json>' }] }
    let payload = null;
    if (Array.isArray(res.result?.content)) {
      const text = res.result.content.map((c) => c?.text ?? '').join('');
      try { payload = JSON.parse(text); } catch { /* ignore */ }
    } else { payload = res.result; }
    return { ok: true, entries: Array.isArray(payload?.entries) ? payload.entries : [] };
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
    const { scope, key, value, tags, source_agent, trigger, org, ttl_days, clear_ttl, created_at } = args;
    const body = { scope, key, value };
    if (tags !== undefined) body.tags = tags;
    if (source_agent !== undefined) body.source_agent = source_agent;
    if (trigger !== undefined) body.trigger = trigger;
    if (org !== undefined) body.org = org;
    if (ttl_days !== undefined) body.ttl_days = ttl_days;
    if (clear_ttl !== undefined) body.clear_ttl = clear_ttl;
    if (created_at !== undefined) body.created_at = created_at;
    const res = await this._rest('/memories', { method: 'POST', body });
    return { ok: res.ok, error: res.error, networkError: res.networkError };
  }

  async delete({ scope, key, force = false } = {}) {
    if (force) {
      // Hard-delete requires MCP — REST only supports soft-archive (archived_at)
      const res = await this._mcp('memory.delete', { scope, key, force: true });
      return { ok: res.ok, error: res.error, networkError: res.networkError };
    }
    // Soft-archive via natural-key REST endpoint
    const p = new URLSearchParams({ scope, key });
    const res = await this._rest(`/memories?${p}`, { method: 'DELETE' });
    return { ok: res.ok, error: res.error, networkError: res.networkError };
  }

  async archive({ scope, key } = {}) {
    // Soft-archive = DELETE without force
    return this.delete({ scope, key, force: false });
  }

  // ── Org operations ─────────────────────────────────────────────────────────
  // Org RPCs (lorekit_org_*) use auth.uid() server-side via SECURITY DEFINER
  // functions, which only works with a Supabase JWT session. CLI uses lk_*
  // api_key tokens which provide no JWT context, so the REST /orgs endpoint
  // returns 403 for api_key callers. Org ops stay on the MCP endpoint which
  // handles this correctly (the Deno edge function has its own auth path).
  // TODO: if org RPCs ever gain api_key support, switch these to REST too.

  async orgCreate({ slug, name } = {}) {
    const res = await this._mcp('org.create', { slug, name });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    let payload = null;
    if (Array.isArray(res.result?.content)) {
      try { payload = JSON.parse(res.result.content.map((c) => c?.text ?? '').join('')); } catch {}
    } else { payload = res.result; }
    return { ok: true, org: payload };
  }

  async orgList() {
    const res = await this._mcp('org.list', {});
    return this._mcpEntries(res);
  }

  async orgRename({ slug, name } = {}) {
    const res = await this._mcp('org.rename', { slug, name });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    let payload = null;
    try { payload = Array.isArray(res.result?.content) ? JSON.parse(res.result.content.map((c) => c?.text ?? '').join('')) : res.result; } catch {}
    return { ok: true, ...(payload ?? {}) };
  }

  async orgDelete({ slug } = {}) {
    const res = await this._mcp('org.delete', { slug });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    let payload = null;
    try { payload = Array.isArray(res.result?.content) ? JSON.parse(res.result.content.map((c) => c?.text ?? '').join('')) : res.result; } catch {}
    return { ok: true, ...(payload ?? {}) };
  }

  // Store-wide scope enumeration is NOT possible against the hosted REST surface:
  // every read tool requires a scope, and there is no "list all scopes" endpoint.
  // Signal that honestly so the `scopes` command shows a clear note rather than
  // faking an inventory.
  async listScopes() {
    return { ok: false, unsupported: true };
  }

  // Connectivity probe for doctor — a transport check, not a memory op.
  async ping() {
    if (!this.usable()) return { ok: false, unusable: true };
    // Use the /health function as a connectivity probe (public, no auth)
    const healthUrl = this.restBase
      ? `${this.restBase.replace(/\/functions\/v1$/, '')}/functions/v1/health`
      : null;
    if (healthUrl) {
      const tp = this._tp();
      try {
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5000),
          ...(tp ? { headers: { traceparent: tp } } : {}),
        });
        return { ok: res.ok, httpStatus: res.status };
      } catch (e) { return { ok: false, networkError: String(e?.message ?? e) }; }
    }
    return mcpCall(this.endpoint, this.token, 'tools/list', {}, { traceparent: this._tp() });
  }
}
