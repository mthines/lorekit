/**
 * The CLOSED set of operation names that may appear as `usage_events.tool_name`.
 *
 * Every surface records usage under an operation name, and the two surfaces
 * deliberately share one vocabulary: `rest-tool-name.ts` maps a REST route to
 * the MCP tool it is the equivalent of, so `POST /memories` and `memory.write`
 * aggregate as one series. That works only while the vocabulary is closed. It
 * currently is not: `restToolName` falls back to `"<fn>.<method>.unmapped"` for
 * anything it does not recognise, which is the right RUNTIME behaviour (a new
 * route gets its own visible bucket instead of corrupting a neighbour's series)
 * and a poor development one — nothing fails, so an unmapped route stays
 * invisible until somebody reads an analytics query and wonders what
 * `memories.put.unmapped` is.
 *
 * This module names the whole set, so that becomes a red test instead:
 *
 *   TELEMETRY_OP_NAMES = the catalog's tool names  ∪  NON_CATALOG_OPS
 *
 * The catalog half is DERIVED (`MCP_TOOLS`), never restated — adding a tool
 * extends the vocabulary automatically. The other half is the part worth
 * writing down: REST routes that have no MCP tool at all, each carrying the
 * reason it has none. An entry is a reviewable decision; the absence of one is
 * the bug the guard catches.
 *
 * Pure, and Node-side ONLY — deliberately NOT mirrored into
 * `supabase/functions/_shared/`. Nothing in the edge tree imports it: the
 * guards are `mcp-core` specs reading source text, and `restToolName` (which
 * IS mirrored) needs no reference to the closed set to do its job. A mirror
 * would buy a permanent sync obligation for no runtime benefit, so unlike
 * `account-wide-tools.ts` this one is free to import the catalog directly.
 */

import { MCP_TOOLS } from '@lorekit/schemas/tool-catalog';

/** One operation name that exists on REST with no MCP tool behind it. */
export interface NonCatalogOp {
  /** Why this operation has no MCP tool. Prose, for the next reader. */
  readonly reason: string;
  /**
   * Set when the absence is a DECISION about the agent-facing surface rather
   * than a consequence of the operation's shape.
   *
   * The distinction matters: `org.get` and the `member.*` operations have no
   * MCP tool because nobody has needed one — a future tool for them would be
   * an ordinary addition. The `restOnly` members were considered and declined
   * for the agent surface, and re-proposing one should mean arguing with a
   * recorded decision rather than filing what looks like a gap. See
   * `docs/decisions.md` → "Dashboard analytics reads stay REST-only".
   */
  readonly restOnly?: string;
}

/**
 * REST operation names with no MCP tool, each with the reason.
 *
 * Keys are the values `REST_TOOL_NAMES` maps to; the guard checks that
 * correspondence in both directions, so a name added to one and not the other
 * fails rather than drifting.
 */
export const NON_CATALOG_OPS: Readonly<Record<string, NonCatalogOp>> = {
  // ── Dashboard analytics: declined for the agent surface (D17) ──────────────
  'memory.usage': {
    reason: 'Usage rollup for the dashboard, keyed by scope_type — an aggregate, not a lesson.',
    restOnly:
      'Charts, not agent primitives. Rolls up by scope_type and emits no scope NAME, so it is '
      + 'the one analytics read with no scope-leak surface — and still nothing an agent loop reads.',
  },
  'memory.usage-runs': {
    reason: 'Enumerates runs (correlation_id values) for the dashboard\u2019s Runs view.',
    restOnly:
      'Charts, not agent primitives — the payoff view for ?correlation_id=, which itself has no '
      + 'MCP tool either. A correlation_id MAY embed a repo/PR identifier '
      + '(e.g. `pr:owner/repo#482`), so this is name-bearing the same way tags/facets/activity/'
      + 'read-ranking are.',
  },
  'memory.tags': {
    reason: 'Label facets for the Explorer filter bar.',
    restOnly:
      'Returns label STRINGS, which embed repo and project names, so an MCP twin would have to '
      + 'thread p_key_scopes to stay inside a restricted key. Real scope-leak surface for a '
      + 'capability no agent loop asked for.',
  },
  'memory.facets': {
    reason: 'Filter-bar drill-down counts per dimension.',
    restOnly: 'Same name-bearing scope-leak surface as memory.tags, for the same absent demand.',
  },
  'memory.activity': {
    reason: 'Write-activity heatmap buckets for the Explorer.',
    restOnly: 'Same name-bearing scope-leak surface as memory.tags, for the same absent demand.',
  },
  'memory.pivot': {
    reason: 'Two-dimensional facet counts behind the Explorer\'s matrix instrument.',
    restOnly:
      'memory.facets with a second group-by, so it inherits that decision exactly: a '
      + 'name-bearing scope-leak surface (origin_repo/origin_branch values) for a charting '
      + 'question no agent loop has asked. An agent that wants the intersection filters '
      + 'memory.list on both dimensions and reads the rows.',
  },
  'memory.read-activity': {
    reason: 'Read-activity counterpart of memory.activity.',
    restOnly: 'Same name-bearing scope-leak surface as memory.tags, for the same absent demand.',
  },
  'memory.read-ranking': {
    reason: 'Hot/cold lore ranked by memories.read_count (migration 00077) for the dashboard.',
    restOnly: 'Same name-bearing scope-leak surface as memory.tags, for the same absent demand.',
  },
  'memory.clusters': {
    reason:
      'Near-duplicate clusters for the Explorer’s Duplicate Clusters panel — a redundancy '
      + 'READING over a recent-writes window, not a lesson read.',
    restOnly:
      'The agent-side spelling of this question already exists and is BETTER: `lorekit dedupe` '
      + 'streams the whole scope and shares the identical clustering core, where this route can '
      + 'only cluster the newest CANDIDATE_LIMIT rows. So an MCP twin would be a strictly weaker '
      + 'answer to a question the CLI already answers, on a name-bearing surface (it returns '
      + 'scope + key + a body hook per member) that would have to thread p_key_scopes to stay '
      + 'inside a restricted key. Same call as memory.tags, for a capability the agent loop '
      + 'reaches through the CLI instead.',
  },

  // ── No MCP tool, but no decision against one either ───────────────────────
  'memory.relevant': {
    // NOT restOnly, and the distinction is the point. This one LOOKS like a
    // sixth analytics read and is not: the capability is already on both the
    // MCP surface and the CLI, under a different name.
    reason:
      'The ranked shortlist. Already covered agent-side by `memory.list order=rank` (MCP) and '
      + '`remote.relevant()` (the CLI hook path); GET /relevant is the dashboard\'s spelling of it. '
      + 'Its own tool_name because ranking and matching answer different questions and folding it '
      + 'into memory.search would hide whether agents reach for the ranking at all.',
  },
  'org.get': {
    reason:
      'Single-org read. `org.list` covers the agent case (which orgs am I in), so a per-slug '
      + 'fetch has had no caller outside the dashboard\'s org settings page.',
  },
  'member.list': { reason: 'Org membership is administered in the dashboard, not by agents.' },
  'member.role_change': { reason: 'Org membership is administered in the dashboard, not by agents.' },
  'member.remove': { reason: 'Org membership is administered in the dashboard, not by agents.' },
  'member.invite_list': { reason: 'Invites are administered in the dashboard, not by agents.' },
  'member.invite': { reason: 'Invites are administered in the dashboard, not by agents.' },
  'member.revoke': { reason: 'Invites are administered in the dashboard, not by agents.' },
};

/**
 * Every name a usage event may legitimately carry.
 *
 * The catalog half is derived, so a new MCP tool needs no edit here; the other
 * half is the declared list above.
 */
export const TELEMETRY_OP_NAMES: ReadonlySet<string> = new Set<string>([
  ...MCP_TOOLS.map((t) => t.name),
  ...Object.keys(NON_CATALOG_OPS),
]);

/**
 * The analytics reads recorded as deliberately REST-only.
 *
 * Derived from the `restOnly` entries rather than listed a second time: the
 * decision's five members are wherever the reasons are, and a sixth added
 * without a reason is not a member.
 */
export const REST_ONLY_OP_NAMES: readonly string[] = Object.entries(NON_CATALOG_OPS)
  .filter(([, op]) => op.restOnly !== undefined)
  .map(([name]) => name);

/** Is this a declared operation name? Total — `false` for anything unlisted. */
export function isDeclaredOpName(name: string): boolean {
  return TELEMETRY_OP_NAMES.has(name);
}
