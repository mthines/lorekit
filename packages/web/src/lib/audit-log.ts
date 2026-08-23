'use server';

/**
 * Server actions for the append-only audit trail (Settings → Audit Logs).
 *
 * Pattern mirrors lib/tokens.ts / lib/webhook-secrets.ts: authenticated by
 * the Supabase user JWT, RLS (`user_id = auth.uid()`) scopes every query to
 * the caller's own rows. NOT an `lk_rw_*` API-token path — the CLAUDE.md
 * `lk_rw_*` rule applies to MCP `api_key` tool calls, not dashboard server
 * actions (same note as webhook-secrets.ts).
 *
 * `recordAuditEvent` is the dashboard-side counterpart of
 * `packages/mcp-core/src/audit/audit.ts`'s `recordAudit` — same non-throwing
 * contract: a failed audit write must never break the caller's primary
 * operation (token creation, webhook rotation, …), so every path here
 * swallows and logs its own errors rather than propagating them.
 */

import { createServerClient } from '@/lib/supabase/server';
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/audit-actions';
import { decodeCursor } from '@/lib/pagination/cursor';
import { clampPageSize, assemblePage, type Page } from '@/lib/pagination/keyset';
import { normalizeActions, substringNeedle, dateRangeBounds, type DateRangeInput } from '@/lib/pagination/filters';
import { applyKeyset, applyAuditFilters, runPaginatedQuery, type FilterBuilderLike } from '@/lib/pagination/apply';

export interface AuditLogEventInput {
  action: AuditAction;
  resourceType?: string | null;
  resourceId?: string | null;
  target?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditLogRow {
  id: string;
  action: AuditAction;
  resource_type: string | null;
  resource_id: string | null;
  target: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditLogFilters {
  /** @deprecated single-action back-compat — prefer `actions` (a SET). */
  action?: AuditAction;
  /** A set of actions to filter by (OR'd together). */
  actions?: AuditAction[];
  /** Case-insensitive substring match on `target`. */
  name?: string;
  /** Inclusive `from`/`to` interval on `created_at`. */
  range?: DateRangeInput | null;
  /** Page size, default 50, hard max 100. */
  pageSize?: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  /** @deprecated back-compat — maps onto `pageSize` when `pageSize` is absent. */
  limit?: number;
}

export type AuditLogPage = Page<AuditLogRow>;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const EMPTY_PAGE: AuditLogPage = { rows: [], nextCursor: null, hasMore: false };

/**
 * Record one audit_log row for the current authenticated user. Never
 * throws — logs and returns on any auth or DB failure so a failed audit
 * write can't break the caller's primary action.
 */
export async function recordAuditEvent(input: AuditLogEventInput): Promise<void> {
  try {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.error('[recordAuditEvent] no authenticated user — skipping audit write for action:', input.action);
      return;
    }

    const { error } = await supabase.from('audit_log').insert({
      user_id: user.id,
      action: input.action,
      resource_type: input.resourceType ?? null,
      resource_id: input.resourceId ?? null,
      target: input.target ?? null,
      metadata: input.metadata ?? null,
    });

    if (error) {
      console.error(`[recordAuditEvent] insert failed for action=${input.action}:`, error.message);
    }
  } catch (err) {
    console.error(`[recordAuditEvent] unexpected error for action=${input.action}:`, (err as Error).message);
  }
}

/**
 * List a keyset page of the current user's audit trail, newest first, with
 * optional combinable filters (action set / name substring / date interval).
 * RLS-scoped — returns only rows this user is allowed to see. Fails closed to
 * an empty page (`{ rows: [], nextCursor: null, hasMore: false }`) on auth
 * failure or DB error; read-only surface, so failing closed is safe here.
 *
 * Pagination/filtering logic itself lives in the pure, audit-decoupled
 * `lib/pagination/*` module — this function is the thin, audit-specific
 * composition of it (decode cursor → normalize filters → build the query →
 * assemble the page).
 */
export async function listAuditLog(filters: AuditLogFilters = {}): Promise<AuditLogPage> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return EMPTY_PAGE;

  const pageSize = clampPageSize(filters.pageSize ?? filters.limit, {
    def: DEFAULT_PAGE_SIZE,
    max: MAX_PAGE_SIZE,
  });
  const cursor = decodeCursor(filters.cursor);
  const actions = normalizeActions(
    filters.actions ?? (filters.action ? [filters.action] : undefined),
    AUDIT_ACTIONS,
  );
  const needle = substringNeedle(filters.name);
  const bounds = dateRangeBounds(filters.range);

  const base = supabase
    .from('audit_log')
    .select('id, action, resource_type, resource_id, target, metadata, created_at')
    .eq('user_id', user.id);

  // because: `apply.ts` is deliberately typed against the minimal
  // `FilterBuilderLike` structural interface (order/limit/or/in/ilike/gte/lt)
  // rather than supabase-js's generated `PostgrestFilterBuilder<...>` type, so
  // the pure pagination module has no dependency on the generated DB types.
  // The real builder has every one of those methods with a compatible runtime
  // shape; the cast bridges the two type worlds at this single call site.
  const filtered = applyAuditFilters(base as unknown as FilterBuilderLike, { actions, needle, bounds });
  const query = applyKeyset(filtered, { cursor, pageSize });

  const { data, error } = await runPaginatedQuery<AuditLogRow>(query);
  if (error) {
    console.error('[listAuditLog] DB error:', error.message);
    return EMPTY_PAGE;
  }

  return assemblePage((data ?? []) as AuditLogRow[], pageSize, (row) => ({ c: row.created_at, id: row.id }));
}
