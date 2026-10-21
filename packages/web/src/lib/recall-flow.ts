/**
 * The recall flow: which surface recalled lore (client), through which read
 * tool, from which kind of scope — as the nodes and links a layered flow chart
 * draws (`lib/flow-layout.ts`).
 *
 * ## Calls, in every band
 *
 * A flow chart is only honest when every band is the same unit. `/usage` rows
 * carry both `event_count` (calls) and `record_count` (records the calls
 * returned); one `memory.list` is one call and possibly hundreds of records, so
 * mixing them would make the bands disagree with their own nodes. Calls are
 * used throughout, because "who is asking" is a question about calls.
 *
 * ## The four lore-read tools, successful calls only
 *
 * The same tool set `/memories/read-activity` counts — `memory.read`,
 * `memory.list`, `memory.search`, `memory.list_archived`. `memory.scopes`,
 * `memory.usage` and the `org.*` reads are catalogue lookups, not recall. Only
 * `outcome === 'ok'` counts: a failed read recalled nothing (failures are the
 * operational-health section's job). This is NOT the same population as the
 * Pulse timeline: that series counts records and excludes dashboard reads,
 * this one counts calls and includes them.
 *
 * ## Dashboard reads are kept
 *
 * Unlike the verdict banner, which excludes your own browsing, this chart's job
 * is to show WHO reads — the dashboard is one of the answers, the same call
 * `AgentBreakdown` makes.
 *
 * ## "unattributed" is a bucket, "other" is a fold
 *
 * A call with no `scope_type` (mostly `memory.search`, whose `scopes[]` array
 * has no single value to record) and a call with no `client` are both
 * UNATTRIBUTED — a real, honestly-named answer, shown and never folded away,
 * the same rule `ScopeConsumption` follows. "other" means only what it says: a
 * scope type outside the known vocabulary, or a value past the top N.
 *
 * ## Read as two pairings, never as paths
 *
 * The rows are aggregates per (client, tool, scope_type), and the chart draws
 * client → tool and tool → scope type as two separate pairings. A band entering
 * a tool and a band leaving it are NOT the same calls continuing; the middle
 * node conserves the total, nothing more. The component's caption says so.
 */

import type { UsageStatRow } from '@lorekit/schemas/usage';
import { bucketScopeType } from '@/lib/usage-health';
import type { FlowLinkInput, FlowNodeInput } from '@/lib/flow-layout';

export const RECALL_TOOLS: ReadonlySet<string> = new Set([
  'memory.read',
  'memory.list',
  'memory.search',
  'memory.list_archived',
]);

/** Named nodes per column before the rest fold into "other". Keeps the palette ≤ 6 hues. */
export const RECALL_FLOW_TOP_N = 5;

export const RECALL_FLOW_COLUMNS = ['Who asked', 'Read tool', 'Scope type'] as const;

export interface RecallFlowRow {
  client: string;
  tool: string;
  scopeType: string;
  calls: number;
}

export interface RecallFlow {
  nodes: FlowNodeInput[];
  links: FlowLinkInput[];
  /** The aggregated rows the chart was built from — the "view as table" source. */
  rows: RecallFlowRow[];
  totalCalls: number;
}

export const OTHER = 'other';
export const UNATTRIBUTED = 'unattributed';

/** `null` client is a genuinely unattributed call — named, not dropped. */
function clientLabel(client: string | null | undefined): string {
  return client ?? UNATTRIBUTED;
}

/** `null` scope type is unattributed; a non-null value outside the vocabulary is "other". */
function scopeTypeLabel(scopeType: string | null): string {
  return scopeType === null ? UNATTRIBUTED : bucketScopeType(scopeType);
}

/** Keep the `limit` largest named keys, plus "unattributed" always; everything else folds into "other". */
function keptKeys(totals: Map<string, number>, limit: number): Set<string> {
  const named = [...totals.entries()]
    .filter(([key]) => key !== OTHER && key !== UNATTRIBUTED)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
  return new Set([...named, UNATTRIBUTED]);
}

function addTo(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Named values by flow, then "unattributed", then "other" — the two catch-alls never outrank a named value. */
function rank(key: string): number {
  if (key === OTHER) return 2;
  if (key === UNATTRIBUTED) return 1;
  return 0;
}

function columnNodes(totals: Map<string, number>, layer: number, prefix: string): FlowNodeInput[] {
  return [...totals.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => ({ id: `${prefix}:${key}`, label: key, layer }));
}

export function recallFlow(usageRows: readonly UsageStatRow[], topN = RECALL_FLOW_TOP_N): RecallFlow {
  const raw: RecallFlowRow[] = usageRows
    .filter((r) => RECALL_TOOLS.has(r.tool_name) && r.outcome === 'ok' && r.event_count > 0)
    .map((r) => ({
      client: clientLabel(r.client),
      tool: r.tool_name,
      scopeType: scopeTypeLabel(r.scope_type),
      calls: r.event_count,
    }));

  const clientTotals = new Map<string, number>();
  const scopeTotals = new Map<string, number>();
  for (const r of raw) {
    addTo(clientTotals, r.client, r.calls);
    addTo(scopeTotals, r.scopeType, r.calls);
  }
  const keepClients = keptKeys(clientTotals, topN);
  const keepScopes = keptKeys(scopeTotals, topN);

  // Re-aggregate after folding, so the table and the chart share one row set.
  const folded = new Map<string, RecallFlowRow>();
  for (const r of raw) {
    const client = keepClients.has(r.client) ? r.client : OTHER;
    const scopeType = keepScopes.has(r.scopeType) ? r.scopeType : OTHER;
    const key = `${client}\u0000${r.tool}\u0000${scopeType}`;
    const existing = folded.get(key);
    if (existing) existing.calls += r.calls;
    else folded.set(key, { client, tool: r.tool, scopeType, calls: r.calls });
  }
  const rows = [...folded.values()].sort((a, b) => b.calls - a.calls);

  const clients = new Map<string, number>();
  const tools = new Map<string, number>();
  const scopes = new Map<string, number>();
  const clientTool = new Map<string, number>();
  const toolScope = new Map<string, number>();
  for (const r of rows) {
    addTo(clients, r.client, r.calls);
    addTo(tools, r.tool, r.calls);
    addTo(scopes, r.scopeType, r.calls);
    addTo(clientTool, `c:${r.client}\u0000t:${r.tool}`, r.calls);
    addTo(toolScope, `t:${r.tool}\u0000s:${r.scopeType}`, r.calls);
  }

  const links: FlowLinkInput[] = [...clientTool, ...toolScope].map(([key, value]) => {
    const [source = '', target = ''] = key.split('\u0000');
    return { source, target, value };
  });

  return {
    nodes: [...columnNodes(clients, 0, 'c'), ...columnNodes(tools, 1, 't'), ...columnNodes(scopes, 2, 's')],
    links,
    rows,
    totalCalls: rows.reduce((sum, r) => sum + r.calls, 0),
  };
}
