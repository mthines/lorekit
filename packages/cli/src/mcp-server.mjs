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
import { readScopeInventory } from './store/scope-inventory.mjs';
import { inferKindHostFromTags } from './lessons-view.mjs';

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
        ttl_days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description:
            'Optional time-to-live in days (1–365). The memory auto-expires that many days after this write and is then hidden from reads.',
        },
        clear_ttl: {
          type: 'boolean',
          description:
            'Remove any existing expiry, making the memory permanent again. Takes precedence over ttl_days when both are supplied.',
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
    inputSchema: {
      type: 'object',
      required: ['scope'],
      properties: {
        scope: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response\'s nextCursor. Omit to start from the first page.' },
        kind: { type: 'string', enum: ['lesson', 'bus', 'signal'], description: 'Filter to one bucket family. Narrowed server-side against the remote store; post-filtered client-side against the local store, whose rows carry no kind/host columns and are classified from their loop:: tag.' },
        host: { type: 'string', description: 'Filter to the owning skill or agent, e.g. `reviewer`. Same server-side/client-side split as kind.' },
        view: { type: 'string', enum: ['full', 'summary'], default: 'full', description: 'summary omits each entry\'s value and returns value_bytes + a 200-character preview instead.' },
      },
    },
  },
  {
    name: 'memory.search',
    description: 'Keyword search across memories',
    inputSchema: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response\'s nextCursor. Omit to start from the first page.' },
      },
    },
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
  {
    name: 'memory.scopes',
    // The description tells the model WHEN to reach for this, not just what it
    // returns: every other read tool needs a scope named up front, so this is
    // the one that answers "what is there?" before you can ask "what is in it?".
    description:
      'List every scope in the store with how many active memories it holds — '
      + 'the inventory to consult when you do not already know which scope to read. '
      + 'Takes no arguments and is store-wide, NOT limited to the current directory.',
    inputSchema: { type: 'object', properties: {} },
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

/** Characters of `value` echoed in a `view: "summary"` entry's `preview`. */
export const LIST_PREVIEW_CHARS = 200;

/** The closed `view` vocabulary, mirroring `MemoryListViewSchema`. */
const LIST_VIEWS = ['full', 'summary'];

/** The closed `kind` vocabulary, mirroring `MemoryKindSchema`. */
const MEMORY_KINDS = ['lesson', 'bus', 'signal'];

/**
 * Validate the taxonomy/projection arguments of a `memory.list` call.
 *
 * Every other surface REJECTS an out-of-vocabulary value — the edge throws
 * `UserInputError`, `ListInputSchema` fails the parse. Letting a typo fall
 * through to the default here would make `lorekit mcp` the one path where
 * `view: "sumary"` silently returns full bodies, or `kind: "lessons"` silently
 * returns every bucket. Throwing keeps the contract uniform.
 */
function validateListArgs(a = {}) {
  if (a.view !== undefined && !LIST_VIEWS.includes(a.view)) {
    throw new Error(`Invalid view "${a.view}": expected "full" or "summary"`);
  }
  if (a.kind !== undefined && !MEMORY_KINDS.includes(a.kind)) {
    throw new Error(`Invalid kind "${a.kind}": expected "lesson", "bus" or "signal"`);
  }
  if (a.host !== undefined && (typeof a.host !== 'string' || a.host.length === 0 || a.host.length > 64)) {
    throw new Error('Invalid host: expected a non-empty string of at most 64 characters');
  }
}

/**
 * Post-filter a list result by `kind` / `host`.
 *
 * The remote store forwards both to `GET /memories` and they are narrowed
 * server-side; the LOCAL store has no kind/host columns and ignores them
 * entirely, so without this a local call that asked to narrow would get the
 * whole scope back and look filtered. This is the same post-filter the read
 * commands already apply in `gather()`, for the same reason — and it is
 * idempotent over already-narrowed remote rows.
 *
 * Taxonomy is taken from the stored columns when present, else inferred from
 * the `loop::…` tag, so an offline row and a pre-`00056` remote row both filter
 * the way a caller expects.
 */
function filterListTaxonomy(result, { kind, host } = {}) {
  if ((!kind && !host) || !result?.ok || !Array.isArray(result.entries)) return result;
  const entries = result.entries.filter((e) => {
    const inferred = inferKindHostFromTags(e?.tags);
    const k = e?.kind ?? inferred.kind ?? null;
    const h = e?.host ?? inferred.host ?? null;
    return (!kind || k === kind) && (!host || h === host);
  });
  return { ...result, entries };
}

/**
 * Apply the `view` projection to a store's list result.
 *
 * `full` (and an absent value) passes the result through untouched. `summary`
 * swaps each entry's `value` for its byte size and a bounded prefix, so a
 * discovery read costs an index instead of every body. An out-of-vocabulary
 * value never reaches here — `validateListArgs` rejects it first.
 *
 * The slice is over `[...value]`, NOT `value.slice()`: JS string indices are
 * UTF-16 code units, so a naive cut can land between a surrogate pair and emit
 * a lone half. Spreading iterates code points, so an emoji or CJK character is
 * never split. `value_bytes` is the UTF-8 byte length so it stays comparable
 * with the 65,536-byte value cap.
 */
export function projectListView(result, view) {
  if (view !== 'summary' || !result?.ok || !Array.isArray(result.entries)) return result;
  return {
    ...result,
    entries: result.entries.map(({ value, ...rest }) => ({
      ...rest,
      value_bytes: Buffer.byteLength(value ?? '', 'utf8'),
      preview: [...(value ?? '')].slice(0, LIST_PREVIEW_CHARS).join(''),
    })),
  };
}

/** The full `memory.list` post-processing chain: validate → filter → project. */
export async function listWithFilters(store, a = {}) {
  validateListArgs(a);
  return projectListView(filterListTaxonomy(await store.list(a), a), a.view);
}

// tool name → (store, args, ctx) → store result. The store destructures the
// args it needs, so the raw `arguments` object is passed straight through.
// `ctx.root` is the resolved project root (`--dir`), NOT the process cwd — an
// MCP client launched from elsewhere would otherwise stamp the wrong origin.
const MEMORY_DISPATCH = {
  // An agent calling memory.write knows the lesson, not the working directory
  // it is running in. Fill in whatever provenance the environment can supply,
  // with anything the caller DID pass taking precedence.
  'memory.write': (store, a, ctx) => store.write({ ...a, ...withDerivedOrigin(a, ctx) }),
  'memory.read': (store, a) => store.read(a),
  // `view` is projected and `kind`/`host` post-filtered client-side rather than
  // forwarded. The remote store reads `GET /memories`, which has no `view`
  // parameter — only the MCP tool does — and the local store has neither the
  // parameter nor the columns. Doing the work here keeps the stdio server's
  // contract identical to the hosted one on both store backends, which is the
  // whole point of `MEMORY_TOOL_DEFS` mirroring the catalog.
  'memory.list': (store, a) => listWithFilters(store, a),
  'memory.search': (store, a) => store.search(a),
  'memory.delete': (store, a) => store.delete(a),
  'memory.archive': (store, a) => store.archive(a),
  'memory.scopes': (store) => listScopes(store),
};

// `memory.scopes` — the store-wide inventory, normalised.
//
// This exists because an agent that cannot enumerate scopes cannot know what it
// does not know. `memory.list` and `memory.search` both need a scope (or a
// scope list) up front, so without this the only reachable lore is the lore
// whose scope the agent could already name — and the SessionStart injection is
// deliberately a bounded slice, not an index of the whole store. `GET
// /memories/scopes` and the `lorekit scopes` command have answered this since
// migration 00039; the MCP surface was the one caller that could not ask.
//
// THE TWO STORES ANSWER IN DIFFERENT SHAPES, and reconciling them is NO LONGER
// this function's job — it moved to `store/scope-inventory.mjs`, which the
// SessionStart scope map reads too. `LocalStore`/`TwoTierStore.listScopes()`
// return a BARE ARRAY (`[{ scope, count }]`), while `RemoteStore.listScopes()`
// returns the standard `{ ok, scopes }` envelope — or `{ ok: false, error,
// networkError, unusable }`. A tool that passed either through verbatim would
// hand the model two different contracts for one tool name depending on a
// config value it cannot see. What is left here is what only the MCP surface
// owns: the ascending sort and the exit-clean degradation below.
//
// DEGRADATION IS EXIT-CLEAN, mirroring the `scopes` command, which reports an
// unreachable remote as a short note at exit 0 rather than failing the run. An
// inventory that cannot be built is `{ scopes: [], note }` with `ok: true`, so
// `toolResult` does NOT mark it `isError`: "I could not enumerate" is a fact
// about the store, not a failed tool call, and a model that receives a
// tool-level error is liable to retry it rather than carry on with the lore it
// can already reach. The note says which, in bounded, non-PII terms.
export async function listScopes(store) {
  // The array-vs-envelope branch and the failure vocabulary live in the shared
  // `store/scope-inventory.mjs` — the SessionStart scope map needs the same
  // normalisation, and two copies of "what does a failed enumeration look like"
  // is how the two surfaces end up disagreeing about it.
  const { ok, scopes, reason } = await readScopeInventory(store);
  // `ok: true` either way: an enumeration that could not run is a fact about
  // the store, not a failed tool call, so it must not reach `toolResult` as an
  // `isError` a model is liable to retry instead of carrying on with the lore
  // it can already reach.
  return ok ? { ok: true, scopes: sortScopes(scopes) } : { ok: true, scopes: [], note: reason };
}

// Sorted by scope ascending, which is the contract `docs/mcp-tools.md`, the
// tool catalog and `llms.txt` all state for `memory.scopes`. The HOSTED surface
// gets that ordering from `lorekit_memory_scopes` (`order by m.scope asc`,
// migration 00039/00049), but `LocalStore`/`TwoTierStore.listScopes()` both
// return their `Map` insertion order — a walk order, not an ordering — so the
// stdio server owns it here rather than the two surfaces answering differently.
// Sorting BOTH shapes (not just the local one) makes the guarantee a property
// of this function instead of an assumption about the store it was handed.
// Codepoint comparison, deliberately not `localeCompare`: the ordering must not
// depend on the HOST's locale.
//
// That is ascending-by-scope, not byte-identical parity with the hosted path,
// and the difference is worth being precise about. `order by m.scope asc` sorts
// under the DATABASE's collation (`en_US.UTF-8` on a default Supabase project),
// which does not order like codepoint around punctuation — and a scope string
// is mostly punctuation (`::`, `/`, `-`), so `repo::a-b` and `repo::ab` can come
// out in the opposite relative order on the two surfaces. Case cannot differ
// (every scope segment is lowercased, see docs/scope-format.md). Closing the
// remaining gap means `collate "C"` on the RPC's `order by`, which changes the
// order `GET /memories/scopes` has always returned — a public contract change
// that belongs in its own migration, not here. Until then: both surfaces are
// sorted ascending, neither is unordered, and nothing should depend on the two
// agreeing on the exact position of a punctuated neighbour.
function sortScopes(rows) {
  return rows.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

// Provenance for a tool call: the caller's explicit values win, the working
// directory and CI environment fill the rest. Best-effort — a failure to shell
// out to git must never fail the write, so it degrades to no origin at all.
function withDerivedOrigin(args = {}, { root } = {}) {
  try {
    return mergeOrigin(deriveOrigin({ cwd: root }), {
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
export function createHandler(control, { root = process.cwd() } = {}) {
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

      const result = await fn(store, args, { root });
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
  const handle = createHandler(control, { root });
  // A human who runs `lorekit mcp` in a terminal would otherwise see a silent
  // hang with no sign it is alive. Reassure them on stderr — but only when
  // stdin is a TTY, so a piped MCP client never sees the banner on either channel.
  if (input && input.isTTY) errorOutput.write(startupBanner(control.mode) + '\n');
  await runStdio(handle, input, output);
  return 0;
}
