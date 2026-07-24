// Remote store: wraps the LoreKit MCP `memory.*` tools behind the common store
// contract. Behaviour is identical to the previous direct `mcpCall` usage —
// this only relocates it behind the interface. Zero-dependency.
import { mcpCall } from '../mcp.mjs';

// LoreKit returns tool output as { content: [{ type:'text', text:'<json>' }] }.
function unwrap(result) {
  if (!result) return null;
  if (Array.isArray(result.content)) {
    const text = result.content.map((c) => (c && c.text) || '').join('');
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return result;
}

// Drop undefined/null args so the JSON-RPC payload matches the old direct calls
// (e.g. `memory.list` with only { scope, limit }).
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export function createRemoteStore({ endpoint, token } = {}) {
  return new RemoteStore(endpoint, token);
}

class RemoteStore {
  constructor(endpoint, token) {
    this.endpoint = endpoint;
    this.token = token;
    this.mode = 'remote';
  }

  usable() {
    return Boolean(this.endpoint && this.token && !String(this.endpoint).includes('<project-ref>'));
  }

  async _call(name, args) {
    if (!this.usable()) return { ok: false, unusable: true };
    return mcpCall(this.endpoint, this.token, 'tools/call', { name, arguments: args });
  }

  _entries(res) {
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    const payload = unwrap(res.result);
    const entries = payload && Array.isArray(payload.entries) ? payload.entries : [];
    return { ok: true, entries };
  }

  async list({ scope, tags, limit } = {}) {
    return this._entries(await this._call('memory.list', clean({ scope, tags, limit })));
  }

  async search({ q, scopes, tags } = {}) {
    return this._entries(await this._call('memory.search', clean({ q, scopes, tags })));
  }

  async read({ scope, key } = {}) {
    const res = await this._call('memory.read', { scope, key });
    if (!res.ok) return { ok: false, error: res.error, networkError: res.networkError };
    const payload = unwrap(res.result);
    return { ok: true, entry: payload && payload.entry ? payload.entry : payload };
  }

  async write(args = {}) {
    const res = await this._call('memory.write', clean(args));
    return { ok: res.ok, error: res.error, networkError: res.networkError, result: res.result };
  }

  async delete({ scope, key, force } = {}) {
    const res = await this._call('memory.delete', { scope, key, force: Boolean(force) });
    return { ok: res.ok, error: res.error, networkError: res.networkError };
  }

  async archive({ scope, key } = {}) {
    const res = await this._call('memory.archive', { scope, key });
    return { ok: res.ok, error: res.error, networkError: res.networkError };
  }

  // Connectivity probe for doctor — a transport check, not a memory op.
  async ping() {
    if (!this.usable()) return { ok: false, unusable: true };
    return mcpCall(this.endpoint, this.token, 'tools/list', {});
  }
}
