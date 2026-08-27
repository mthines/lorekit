// The REST → `usage_events.tool_name` mapping.
//
// The MCP surface records one usage event per tool call, keyed by the MCP tool
// name (`memory.write`, `memory.read`, …). The REST surface records one usage
// event per dispatched route (`_shared/api/router.ts`). If the two surfaces
// invented different names for the same operation, every usage/plan-sizing
// query would have to know both vocabularies and the data would fragment the
// moment the CLI moved a command from MCP to REST — which is exactly what just
// happened. So a REST route reports the name of the MCP tool it is the
// equivalent of, and the two aggregate as one series.
//
// Where no MCP tool exists (the `orgs` function's member/invite sub-resources,
// the aggregate `GET /memories/scopes`, `/tags`, `/activity`, `/read-activity` and
// `GET /memories/usage`) the name is
// drawn from the vocabulary already used
// for the same concept elsewhere: the `org.*` MCP tools, and the `member.*`
// `audit_log` actions (supabase/migrations/00023_audit_log_org_actions.sql).
// No new naming scheme is introduced here.
//
// Pure and import-free so it can be mirrored verbatim into
// `supabase/functions/_shared/rest/rest-tool-name.ts` (the edge tree cannot
// cross-import this package) and unit-tested in Node — the edge functions have
// no test harness of their own. `edge-parity.spec.ts` guards the two copies.

/** One dispatched REST route, as the router knows it. */
export interface RestRouteRef {
  /** Edge function name — the first path segment, e.g. `memories`, `orgs`. */
  fn: string;
  /** HTTP method; case-insensitive. */
  method: string;
  /** The REGISTERED route pattern (not the concrete path), e.g. `/:id`. */
  path: string;
  /** DELETE only: `?force=true` selects a hard delete over a soft archive. */
  force?: boolean;
}

/**
 * `"<fn> <METHOD> <route pattern>"` → tool name.
 *
 * The two DELETE routes are absent on purpose: they are the only routes whose
 * name depends on a query parameter (`force`), so they are resolved by
 * `restToolName` below rather than by a table lookup that could not see it.
 */
export const REST_TOOL_NAMES: Readonly<Record<string, string>> = {
  // ── memories ──────────────────────────────────────────────────────────────
  'memories GET /': 'memory.list',
  'memories POST /': 'memory.write',
  'memories POST /search': 'memory.search',
  'memories POST /restore': 'memory.restore',
  'memories POST /purge': 'memory.purge',
  'memories POST /purge-expired': 'memory.purge_expired',
  'memories GET /scopes': 'memory.scopes',
  'memories GET /usage': 'memory.usage',
  'memories GET /usage/runs': 'memory.usage-runs',
  'memories GET /tags': 'memory.tags',
  'memories GET /facets': 'memory.facets',
  'memories GET /activity': 'memory.activity',
  // The BODY transport for the three filtered reads. Deliberately mapped to the
  // SAME tool names as their GET siblings: they are one operation spelled two
  // ways, not two operations. Giving them their own names would have collapsed
  // `memory.list` to zero and opened a fresh series on the day the dashboard
  // switched transports, making the usage ledger read as an outage.
  'memories POST /list': 'memory.list',
  'memories POST /facets': 'memory.facets',
  'memories POST /activity': 'memory.activity',
  'memories GET /read-activity': 'memory.read-activity',
  'memories GET /read-ranking': 'memory.read-ranking',
  // The ranked shortlist. Its own tool name rather than folding into
  // `memory.search`: the two answer different questions (what matches vs what
  // is worth reading) and collapsing them would make it impossible to tell
  // whether agents actually reach for the ranking.
  'memories GET /relevant': 'memory.relevant',
  'memories GET /:id': 'memory.read',
  'memories PATCH /:id': 'memory.write',
  'memories POST /:id/restore': 'memory.restore',
  // ── orgs ──────────────────────────────────────────────────────────────────
  'orgs GET /': 'org.list',
  'orgs POST /': 'org.create',
  'orgs GET /:slug': 'org.get',
  'orgs PATCH /:slug': 'org.rename',
  'orgs DELETE /:slug': 'org.delete',
  'orgs GET /:slug/members': 'member.list',
  'orgs PATCH /:slug/members/:userId': 'member.role_change',
  'orgs DELETE /:slug/members/:userId': 'member.remove',
  'orgs GET /:slug/invites': 'member.invite_list',
  'orgs POST /:slug/invites': 'member.invite',
  'orgs DELETE /:slug/invites/:inviteId': 'member.revoke',
};

/** The DELETE routes on `memories`, whose name depends on `?force=`. */
const MEMORY_DELETE_ROUTES = ['/', '/:id'];

/**
 * Resolve the `usage_events.tool_name` for a dispatched REST route.
 *
 * Total: an unmapped route yields `"<fn>.<method>.unmapped"` rather than
 * throwing or silently borrowing another route's name — a new route that
 * nobody added here shows up as its own visible bucket in analytics instead of
 * corrupting an existing series. Cardinality stays bounded (function count ×
 * method count).
 */
export function restToolName(ref: RestRouteRef): string {
  const method = ref.method.toUpperCase();
  if (ref.fn === 'memories' && method === 'DELETE' && MEMORY_DELETE_ROUTES.includes(ref.path)) {
    return ref.force ? 'memory.delete' : 'memory.archive';
  }
  return REST_TOOL_NAMES[`${ref.fn} ${method} ${ref.path}`] ?? `${ref.fn}.${method.toLowerCase()}.unmapped`;
}
