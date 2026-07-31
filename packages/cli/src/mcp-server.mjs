// `lorekit mcp` — a zero-dependency local MCP stdio server.
//
// Speaks JSON-RPC 2.0 over newline-delimited stdin/stdout (the MCP stdio
// transport) and serves LoreKit's memory.* tools from the store the control
// model resolves. This makes `lorekit mcp` a uniform local entrypoint for
// every mode, so an agent's `.mcp.json` can point at the local CLI instead of
// `mcp-remote <url>`:
//
//   local  → serve the `.lorekit/` file store directly (offline, no network)
//   remote → pass tool calls through to the hosted HTTP endpoint
//   off    → advertise no tools; a call reports "disabled"
//
// org.* tools are always advertised regardless of memory mode. They proxy to
// the remote endpoint because orgs are server-side state — there is no local
// equivalent to serve them from. (They no longer require a Supabase JWT: the
// store calls the REST `/orgs` routes, which accept `lk_*` API tokens as of
// 00041_org_actor_override.sql.) In local/off mode a transient RemoteStore is
// built from the configured endpoint + token. If no remote is configured, a
// clear error is returned.
//
// Machine-facing: ONLY JSON-RPC frames go to stdout — any diagnostics go to
// stderr. The server never throws on malformed or partial input; a bad frame
// yields a JSON-RPC parse error and the loop keeps serving.
//
// The transport is hand-rolled (no MCP SDK) to keep the CLI dependency-free.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { loadControl } from './control.mjs';
import { createStore } from './store/index.mjs';
import { createRemoteStore } from './store/remote.mjs';
import { deriveOrigin, mergeOrigin } from './origin.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'lorekit-local', version: '1.0.0' };

// Tool advertisements — names + input schemas mirror the production MCP server
// (supabase/functions/mcp/mcp-handler.ts) so a client sees the same contract
// whether it points at the hosted endpoint or this local server.
export const MEMORY_TOOL_DEFS = [
  {
    name: 'memory.write',
    description: 'Store or update a memory',
    inputSchema: {
      type: 'object',
      required: ['scope', 'key', 'value'],
      properties: {
        scope: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        source_agent: { type: 'string' },
        trigger: { type: 'string' },
        created_at: {
          type: 'string',
          format: 'date-time',
          description:
            'Optional ISO 8601 creation date for migrating a pre-existing memory. Rejected if invalid or in the future. Applies only when the memory is first created.',
        },
        origin_repo: {
          type: 'string',
          description:
            'Provenance: the owner/name of the repository this memory was recorded from. Derived from the working directory when omitted.',
        },
        origin_branch: {
          type: 'string',
          description:
            'Provenance: the git branch this memory was recorded from. Derived from the working directory when omitted.',
        },
        origin_commit: {
          type: 'string',
          description:
            'Provenance: the commit SHA checked out when this memory was recorded. Derived from the working directory when omitted.',
        },
        origin_pr: {
          type: 'integer',
          minimum: 1,
          description:
            'Provenance: the pull request number this memory came out of. Pass it when you know it — the server can only infer it from CI environment variables.',
        },
      },
    },
  },
  {
    name: 'memory.read',
    description: 'Read a memory by scope and key',
    inputSchema: { type: 'object', required: ['scope', 'key'] },
  },
  {
    name: 'memory.list',
    description: 'List memories for a scope',
    inputSchema: { type: 'object', required: ['scope'] },
  },
  {
    name: 'memory.search',
    description: 'Keyword search across memories',
    inputSchema: { type: 'object', required: ['q'] },
  },
  {
    name: 'memory.delete',
    description:
      'Soft-archive a memory (default) or hard-delete it (force: true). ' +
      'Archived memories are hidden from reads but can be restored.',
    inputSchema: {
      type: 'object',
      required: ['scope', 'key'],
      properties: {
        scope: { type: 'string' },
        key: { type: 'string' },
        force: { type: 'boolean' },
      },
    },
  },
  {
    name: 'memory.archive',
    description: 'Soft-archive a memory. Hidden from reads but restorable.',
    inputSchema: { type: 'object', required: ['scope', 'key'] },
  },
];

// Org tools — always advertised regardless of memory mode. They always route
// through the remote MCP endpoint because org management requires JWT auth
// (SECURITY DEFINER RPCs resolve actor via auth.uid(), never a passed user_id).
export const ORG_TOOL_DEFS = [
  {
    name: 'org.create',
    description:
      'Create a new organization. You become its owner automatically. ' +
      'The slug must be globally unique and lowercase (letters, digits, hyphens).',
    inputSchema: {
      type: 'object',
      required: ['slug', 'name'],
      properties: {
        slug: { type: 'string', description: 'Unique lowercase identifier, e.g. "my-team"' },
        name: { type: 'string', description: 'Human-readable display name' },
      },
    },
  },
  {
    name: 'org.list',
    description: 'List all organizations you are a member of, with your role in each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'org.rename',
    description: 'Rename an organization\'s display name. Requires admin or owner role.',
    inputSchema: {
      type: 'object',
      required: ['slug', 'name'],
      properties: {
        slug: { type: 'string', description: 'The org slug to update' },
        name: { type: 'string', description: 'New display name' },
      },
    },
  },
  {
    name: 'org.delete',
    description:
      'Permanently delete an organization. Requires owner role. ' +
      'All org-owned memories and memberships are cascade-deleted. Unrecoverable.',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'The org slug to delete' },
      },
    },
  },
];

// Legacy alias kept so existing code that imports TOOL_DEFS still compiles.
export const TOOL_DEFS = [...MEMORY_TOOL_DEFS, ...ORG_TOOL_DEFS];

// tool name → (store, args) → store result. The store destructures the args it
// needs, so the raw `arguments` object is passed straight through.
const MEMORY_DISPATCH = {
  // An agent calling memory.write knows the lesson, not the working directory
  // it is running in. Fill in whatever provenance the environment can supply,
  // with anything the caller DID pass taking precedence.
  'memory.write': (store, a) => store.write({ ...a, ...withDerivedOrigin(a) }),
  'memory.read': (store, a) => store.read(a),
  'memory.list': (store, a) => store.list(a),
  'memory.search': (store, a) => store.search(a),
  'memory.delete': (store, a) => store.delete(a),
  'memory.archive': (store, a) => store.archive(a),
};

// Provenance for a tool call: the caller's explicit values win, the working
// directory and CI environment fill the rest. Best-effort — a failure to shell
// out to git must never fail the write, so it degrades to no origin at all.
function withDerivedOrigin(args = {}) {
  try {
    return mergeOrigin(deriveOrigin(), {
      origin_repo: args.origin_repo ?? null,
      origin_branch: args.origin_branch ?? null,
      origin_commit: args.origin_commit ?? null,
      origin_pr: args.origin_pr ?? null,
    });
  } catch {
    return {};
  }
}

// org.* dispatch — always routed to the remote store.
const ORG_DISPATCH = {
  'org.create': (remote, a) => remote.orgCreate(a),
  'org.list': (remote) => remote.orgList(),
  'org.rename': (remote, a) => remote.orgRename(a),
  'org.delete': (remote, a) => remote.orgDelete(a),
};

function reply(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorReply(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Wrap a store result in the MCP tools/call result shape. `ok: false` from the
// store surfaces as a tool-level error (isError) rather than a protocol error,
// so the model sees the failure payload instead of a broken transport.
function toolResult(id, payload) {
  const isError = payload && payload.ok === false;
  return reply(id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  });
}

// Build the per-message handler over a resolved control model. `store` is null
// when mode is `off`. Org tools are always advertised regardless of mode.
export function createHandler(control) {
  const store = createStore(control);
  const memoryTools = store ? MEMORY_TOOL_DEFS : [];

  // For org.* calls: prefer the active remote store (already built if mode is
  // remote); fall back to building one from control.connection so org management
  // works even in local/off modes as long as a remote endpoint is configured.
  function getOrgRemote() {
    if (store && store.mode === 'remote') return store;
    const conn = (control && control.connection) || {};
    if (conn.endpoint && conn.token) {
      return createRemoteStore({ endpoint: conn.endpoint, token: conn.token });
    }
    return null;
  }

  // Returns a JSON-RPC response object, or null for a notification (no reply).
  return async function handle(msg) {
    const id = msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null;
    const isNotification = id === null || id === undefined;
    const method = msg && msg.method;

    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    // Notifications (initialized, cancelled, …) never get a response.
    if (typeof method === 'string' && method.startsWith('notifications/')) {
      return null;
    }

    if (method === 'tools/list') {
      return reply(id, { tools: [...memoryTools, ...ORG_TOOL_DEFS] });
    }

    if (method === 'tools/call') {
      const params = (msg && msg.params) || {};
      const name = params.name;
      const args = params.arguments || {};

      // org.* tools — always proxy to remote.
      if (name && name.startsWith('org.')) {
        const fn = ORG_DISPATCH[name];
        if (!fn) return errorReply(id, -32601, `Unknown tool: ${name}`);
        const remote = getOrgRemote();
        if (!remote) {
          return toolResult(id, {
            ok: false,
            error:
              'org.* tools require a remote LoreKit endpoint configured with a read-write token. ' +
              'Set LOREKIT_MCP_URL and LOREKIT_TOKEN (lk_rw_*), or run `lorekit install --endpoint <url> --token <lk_rw_*>`.',
          });
        }
        const result = await fn(remote, args);
        return toolResult(id, result);
      }

      // memory.* tools
      if (!store) {
        return toolResult(id, { ok: false, error: `memory is disabled (mode: ${control.mode})` });
      }

      const fn = MEMORY_DISPATCH[name];
      if (!fn) return errorReply(id, -32601, `Unknown tool: ${name}`);

      const result = await fn(store, args);
      return toolResult(id, result);
    }

    // Unknown or missing method. A notification gets silence; a request gets
    // a proper JSON-RPC "method not found".
    if (isNotification) return null;
    return errorReply(id, -32601, `Method not found: ${method}`);
  };
}

// The stdio read/write loop. Split out from the process streams so it can be
// driven by any duplex-ish pair in tests. Frames are newline-delimited JSON;
// responses are serialized single-line + '\n' and written in arrival order.
export function runStdio(handle, input, output) {
  return new Promise((resolve) => {
    let buffer = '';
    let chain = Promise.resolve();

    const writeMsg = (obj) => {
      if (obj != null) output.write(`${JSON.stringify(obj)}\n`);
    };

    const handleOne = (m) =>
      Promise.resolve()
        .then(() => handle(m))
        .then(writeMsg)
        .catch((e) => {
          // A handler fault must not take the server down; report it and go on.
          const id = m && Object.prototype.hasOwnProperty.call(m, 'id') ? m.id : null;
          writeMsg(errorReply(id ?? null, -32603, String(e && e.message ? e.message : e)));
        });

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // Malformed frame: we cannot know the id, so reply with null id and
        // keep serving. This is the "never crash on bad input" guarantee.
        writeMsg(errorReply(null, -32700, 'Parse error'));
        return;
      }
      // Serialize so responses are written in the order frames arrived. A batch
      // (JSON-RPC array) is handled element-wise rather than crashing.
      chain = chain.then(() =>
        Array.isArray(msg) ? Promise.all(msg.map(handleOne)) : handleOne(msg),
      );
    };

    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        processLine(line);
      }
    });
    input.on('end', () => {
      if (buffer) processLine(buffer);
      buffer = '';
      chain.then(resolve, resolve);
    });
    input.on('error', () => {
      chain.then(resolve, resolve);
    });
  });
}

function withOverrides(args, env) {
  const out = { ...env };
  if (args.store) out.LOREKIT_STORE = args.store;
  if (args.mode) out.LOREKIT_MODE = args.mode;
  if (args.endpoint) out.LOREKIT_MCP_URL = args.endpoint;
  if (args.token) out.LOREKIT_TOKEN = args.token;
  return out;
}

// A one-line human-readable readiness banner for `lorekit mcp`. Pure so it can
// be unit-tested. Printed to STDERR (never stdout — that channel carries only
// JSON-RPC frames) and only when stdin is a TTY, so a real MCP client that
// pipes to us gets a pristine, banner-free stdout AND stderr.
export function startupBanner(mode) {
  return (
    `lorekit mcp — local stdio MCP server ready (mode: ${mode}). ` +
    'Speaking JSON-RPC 2.0 on stdin/stdout; this is machine-facing, so no ' +
    'further output is normal. Press Ctrl-C to stop.'
  );
}

// Entrypoint for `lorekit mcp`. Resolves the store once, then serves stdio
// until the client closes stdin. Always resolves to exit code 0.
export async function mcpServer(
  args = {},
  { env = process.env, input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {},
) {
  const root = resolveProjectRoot(args.dir);
  const control = loadControl(root, { env: withOverrides(args, env) });
  const handle = createHandler(control);
  // A human who runs `lorekit mcp` in a terminal would otherwise see a silent
  // hang with no sign it is alive. Reassure them on stderr — but only when
  // stdin is a TTY, so a piped MCP client never sees the banner on either channel.
  if (input && input.isTTY) errorOutput.write(startupBanner(control.mode) + '\n');
  await runStdio(handle, input, output);
  return 0;
}
