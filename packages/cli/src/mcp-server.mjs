// `lorekit mcp` — a zero-dependency local MCP stdio server.
//
// Speaks JSON-RPC 2.0 over newline-delimited stdin/stdout (the MCP stdio
// transport) and serves LoreKit's memory.* tools from the store the control
// model resolves. This makes `lorekit mcp` a uniform local entrypoint for
// every mode, so an agent's `.mcp.json` can point at the local CLI instead of
// `mcp-remote <url>`:
//
//   local  → serve the `.lore/` file store directly (offline, no network)
//   remote → pass tool calls through to the hosted HTTP endpoint
//   off    → advertise no tools; a call reports "disabled"
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

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'lorekit-local', version: '1.0.0' };

// Tool advertisements — names + input schemas mirror the production MCP server
// (supabase/functions/mcp/mcp-handler.ts) so a client sees the same contract
// whether it points at the hosted endpoint or this local server.
export const TOOL_DEFS = [
  {
    name: 'memory.write',
    description: 'Store or update a lesson',
    inputSchema: { type: 'object', required: ['scope', 'key', 'value'] },
  },
  {
    name: 'memory.read',
    description: 'Read a lesson by scope and key',
    inputSchema: { type: 'object', required: ['scope', 'key'] },
  },
  {
    name: 'memory.list',
    description: 'List lessons for a scope',
    inputSchema: { type: 'object', required: ['scope'] },
  },
  {
    name: 'memory.search',
    description: 'Keyword search across lessons',
    inputSchema: { type: 'object', required: ['q'] },
  },
  {
    name: 'memory.delete',
    description:
      'Soft-archive a lesson (default) or hard-delete it (force: true). ' +
      'Archived lessons are hidden from reads but can be restored.',
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
    description: 'Soft-archive a lesson. Hidden from reads but restorable.',
    inputSchema: { type: 'object', required: ['scope', 'key'] },
  },
];

// tool name → (store, args) → store result. The store destructures the args it
// needs, so the raw `arguments` object is passed straight through.
const DISPATCH = {
  'memory.write': (store, a) => store.write(a),
  'memory.read': (store, a) => store.read(a),
  'memory.list': (store, a) => store.list(a),
  'memory.search': (store, a) => store.search(a),
  'memory.delete': (store, a) => store.delete(a),
  'memory.archive': (store, a) => store.archive(a),
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
// when mode is `off`, in which case no tools are advertised.
export function createHandler(control) {
  const store = createStore(control);
  const tools = store ? TOOL_DEFS : [];

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
      return reply(id, { tools });
    }

    if (method === 'tools/call') {
      const params = (msg && msg.params) || {};
      const name = params.name;
      const args = params.arguments || {};

      if (!store) {
        return toolResult(id, { ok: false, error: `memory is disabled (mode: ${control.mode})` });
      }

      const fn = DISPATCH[name];
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

// Entrypoint for `lorekit mcp`. Resolves the store once, then serves stdio
// until the client closes stdin. Always resolves to exit code 0.
export async function mcpServer(args = {}, { env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const root = resolveProjectRoot(args.dir);
  const control = loadControl(root, { env: withOverrides(args, env) });
  const handle = createHandler(control);
  await runStdio(handle, input, output);
  return 0;
}
