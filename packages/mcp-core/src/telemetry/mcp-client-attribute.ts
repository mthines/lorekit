/**
 * The BOUNDED value behind the `lorekit.mcp.client.name` telemetry attribute
 * and `usage_events.mcp_client` — WHICH MCP HOST is talking to us.
 *
 * ## Why this dimension exists
 *
 * `memory.read`'s top-level `oneOf` (#654) made Amazon Bedrock reject the
 * WHOLE `tools/list`, so every Bedrock-hosted agent lost the LoreKit server
 * outright, and a second client dropped `memory.read` alone from a 22-tool
 * list. Neither failure produced a single error on this side: `tools/list`
 * answered 200 with a valid result and the rejection happened afterwards, in
 * the host's own process, against the host's own model API. The last event in
 * our system was a success.
 *
 * Nothing can recover the upstream error — there is no callback. What CAN be
 * recovered is the shape of the absence, and both shapes are only legible per
 * client:
 *
 *   - hard failure  — a host that handshakes, lists, and then never calls a
 *     tool at all.
 *   - degradation   — a host that keeps calling every tool EXCEPT the one
 *     whose schema it refused.
 *
 * Neither is visible in an aggregate: total traffic barely moves when one host
 * family drops out, and "`memory.read` calls fell" is unreadable without
 * knowing whose. This module is the dimension that makes both queryable, so
 * the next portability regression is a chart with a step in it rather than a
 * bug report from two orgs.
 *
 * ## Why `lorekit.*` and not `mcp.*`
 *
 * Checked upstream first (OTel semconv 1.43.0), which is the ordering to
 * follow, and it defines `mcp.method.name`, `mcp.protocol.version`,
 * `mcp.session.id` and `mcp.resource.uri` — but NO attribute for client
 * identity. The `mcp.client.*` prefix upstream is spent on client-role METRIC
 * names (`mcp.client.operation.duration`, `mcp.client.session.duration`), so
 * putting a server-side identity attribute at `mcp.client.name` would squat on
 * a reserved namespace with unrelated semantics and collide if upstream ever
 * defines it. Nothing upstream fits ⇒ this is LoreKit-internal, and it lives
 * next to `lorekit.tool.name` and `lorekit.scope.type`.
 *
 * The word `client` is already spent TWICE in this codebase with other
 * meanings — `usage_events.client` is the SURFACE (`dashboard`/`cli`/`mcp`/
 * `api`, from `X-LoreKit-Client`) and `usage_events.host` is a bucket's owning
 * host — which is why this one is namespaced under `mcp.` on spans and stored
 * as `mcp_client`, never as a second `client`.
 *
 * ## The two rules, which are the whole module
 *
 * 1. The OUTPUT is always drawn from {@link MCP_CLIENT_IDS}. `clientInfo.name`
 *    and `User-Agent` are caller-supplied free text, so echoing either would
 *    hand an unbounded dimension to anyone who can set a header. An
 *    unrecognised name reports `other` — one bucket, never the caller's own
 *    string.
 * 2. Absence OMITS the attribute rather than inventing one, the
 *    `scope-type-attribute.ts` posture: a placeholder is a value that
 *    aggregates, and it would aggregate into the largest bucket of the
 *    dimension while meaning "nobody told us".
 *
 * The `client_info` / `user_agent` split in rule 1 is deliberate and is not
 * symmetric. A host that sent a `clientInfo` we do not recognise is a real,
 * countable unknown MCP client ⇒ `other`. A bare `User-Agent` we do not
 * recognise is usually a runtime's default (`node`, `undici`) or absent
 * entirely, and says nothing about the host ⇒ `null`, so it omits rather than
 * polluting the bucket that means "an MCP client we have not catalogued".
 *
 * A growing `other` share is the signal to extend {@link CLIENT_PATTERNS} —
 * the list starts deliberately short and is not a claim to be exhaustive.
 *
 * Import-free, so it can be mirrored verbatim into
 * `supabase/functions/_shared/telemetry/mcp-client-attribute.ts` and kept in
 * sync by `edge-parity.spec.ts` — the `scope-type-attribute.ts` pattern.
 */

/**
 * The closed vocabulary. `other` is the single bucket for "a client identified
 * itself and we do not recognise the name" — the counterpart of
 * `scope-type-attribute.ts`'s `invalid`.
 *
 * A runtime ARRAY with the type derived from it, rather than a union declared
 * on its own, because the parse has to VALIDATE against the vocabulary at
 * runtime and a type-only union is not available to do it.
 */
export const MCP_CLIENT_IDS = [
  'claude-code',
  'claude-desktop',
  'agent0',
  'cursor',
  'windsurf',
  'vscode',
  'cline',
  'continue',
  'zed',
  'lorekit-cli',
  'mcp-remote',
  'mcp-inspector',
  'other',
] as const;

export type McpClientId = (typeof MCP_CLIENT_IDS)[number];

/** Where the identity came from. Bounded; reported so a reader knows the fidelity. */
export const MCP_CLIENT_SOURCES = ['client_info', 'user_agent'] as const;

export type McpClientSource = (typeof MCP_CLIENT_SOURCES)[number];

/**
 * Substring patterns, FIRST MATCH WINS — order is load-bearing.
 *
 * Hosts spell themselves inconsistently across `clientInfo.name` and
 * `User-Agent` ("Claude Code", "claude-code", "claude-ai"), so this matches on
 * a normalised substring rather than equality. The ordering rule that matters:
 * a longer, more specific pattern must precede any pattern that is its prefix,
 * or the general one shadows it — `claude-code` before `claude`, `mcp-inspector`
 * before `mcp`. `mcp-client-attribute.spec.ts` pins that with a shadowing test
 * so a later insertion in the wrong place fails rather than silently
 * re-bucketing a client.
 */
const CLIENT_PATTERNS: readonly (readonly [pattern: string, id: McpClientId])[] = [
  ['claude-code', 'claude-code'],
  ['claude-desktop', 'claude-desktop'],
  ['claude-ai', 'claude-desktop'],
  ['agent0', 'agent0'],
  ['cursor', 'cursor'],
  ['windsurf', 'windsurf'],
  ['cline', 'cline'],
  ['continue', 'continue'],
  ['zed', 'zed'],
  ['lorekit', 'lorekit-cli'],
  ['mcp-inspector', 'mcp-inspector'],
  ['modelcontextprotocol-inspector', 'mcp-inspector'],
  ['mcp-remote', 'mcp-remote'],
  // Last among the editors: "Visual Studio Code" also appears inside some
  // extensions' own UA strings, so anything with its own name is matched first.
  ['visual-studio-code', 'vscode'],
  ['vscode', 'vscode'],
];

/**
 * Lowercase, then collapse every run of non-alphanumerics to a single `-` and
 * trim them from the ends, so `"Claude Code"`, `"claude_code"` and
 * `"Claude/Code"` all normalise to `claude-code` and one pattern matches all
 * three spellings.
 */
function normalise(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function matchId(raw: string): McpClientId | null {
  const name = normalise(raw);
  if (!name) return null;
  for (const [pattern, id] of CLIENT_PATTERNS) {
    if (name.includes(pattern)) return id;
  }
  return null;
}

/**
 * Accept a version only if it is short and version-SHAPED. Unlike the name,
 * this is passed through rather than mapped to a closed set, so it is the one
 * value here that could carry caller text into telemetry — hence a
 * conservative allowlist of characters and a hard length cap, and hence the
 * caller contract in {@link resolveMcpClient} that it is stamped on the
 * `initialize` span ONLY. `initialize` is once per session; a per-request
 * version attribute would put an open-ended dimension on every span.
 */
function sanitiseVersion(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 32) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed) ? trimmed : null;
}

export interface McpClientAttribute {
  /** Bounded id, or `null` when nothing identified the caller (omit the attribute). */
  readonly name: McpClientId | null;
  /** Which input answered. `null` exactly when {@link name} is `null`. */
  readonly source: McpClientSource | null;
  /**
   * The host's self-reported version, from `clientInfo` only and never from a
   * `User-Agent`. `null` when absent or not version-shaped. Stamp on the
   * `initialize` span only — see {@link sanitiseVersion}.
   */
  readonly version: string | null;
}

const ABSENT: McpClientAttribute = { name: null, source: null, version: null };

/**
 * Resolve the bounded MCP client identity from the two things a stateless
 * server can see.
 *
 * `clientInfo` is authoritative but arrives ONLY on `initialize`; this server
 * negotiates protocol `2024-11-05` over plain POSTs with no session, so
 * `tools/list` and `tools/call` are separate requests that do not carry it.
 * That is why `User-Agent` is read at all: it is the only per-request client
 * signal available, and without it every tool-call span would be unlabelled —
 * which is precisely the per-tool question this dimension exists to answer.
 * It is best-effort by nature and frequently absent (a host on `node`'s own
 * `fetch` sends no useful agent), so treat a `user_agent` source as a hint and
 * `client_info` as the record.
 *
 * `clientInfo` is typed `unknown` because it comes straight off a parsed JSON
 * body, before any schema has looked at it.
 */
export function resolveMcpClient(input: {
  readonly clientInfo?: unknown;
  readonly userAgent?: string | null;
}): McpClientAttribute {
  const info = input.clientInfo;
  if (info && typeof info === 'object') {
    const rawName = (info as { name?: unknown }).name;
    if (typeof rawName === 'string' && normalise(rawName)) {
      const rawVersion = (info as { version?: unknown }).version;
      return {
        // Rule 1: a client that named itself and is not in the vocabulary is a
        // countable unknown, so it lands in `other` rather than being dropped.
        name: matchId(rawName) ?? 'other',
        source: 'client_info',
        version: typeof rawVersion === 'string' ? sanitiseVersion(rawVersion) : null,
      };
    }
  }

  const ua = input.userAgent;
  if (typeof ua === 'string') {
    const fromUa = matchId(ua);
    // Deliberately NOT `?? 'other'`: an unrecognised User-Agent is usually a
    // runtime default and identifies nothing, so it omits instead of inflating
    // the bucket that means "an unrecognised MCP client".
    if (fromUa) return { name: fromUa, source: 'user_agent', version: null };
  }

  return ABSENT;
}

/**
 * The span attributes for a resolved identity, ready to spread into
 * `setAttributes`. Empty when nothing identified the caller (rule 2).
 *
 * `includeVersion` is opt-in and the caller passes it on `initialize` only —
 * the one request per session where an open-ended value is affordable.
 *
 * Note the attribute names sit UNDER `lorekit.mcp.client.` rather than at it:
 * an attribute must not also be a namespace prefix of another attribute, so
 * there is no bare `lorekit.mcp.client`.
 */
export function mcpClientAttributes(
  resolved: McpClientAttribute,
  options: { readonly includeVersion?: boolean } = {},
): Record<string, string> {
  if (!resolved.name || !resolved.source) return {};
  return {
    'lorekit.mcp.client.name': resolved.name,
    'lorekit.mcp.client.source': resolved.source,
    ...(options.includeVersion && resolved.version
      ? { 'lorekit.mcp.client.version': resolved.version }
      : {}),
  };
}
