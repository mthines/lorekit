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
 * `packages/mcp-core/src/audit.ts`'s `recordAudit` — same non-throwing
 * contract: a failed audit write must never break the caller's primary
 * operation (token creation, webhook rotation, …), so every path here
 * swallows and logs its own errors rather than propagating them.
 */

import { createServerClient } from '@/lib/supabase/server';
import type { AuditAction } from '@/lib/audit-actions';

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
  action?: AuditAction;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 100;

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
 * List the current user's audit trail, newest first. RLS-scoped — returns
 * only rows this user is allowed to see. Returns [] on auth failure or DB
 * error (read-only surface; failing closed to an empty list is safe here).
 */
export async function listAuditLog(filters: AuditLogFilters = {}): Promise<AuditLogRow[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  let query = supabase
    .from('audit_log')
    .select('id, action, resource_type, resource_id, target, metadata, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIST_LIMIT);

  if (filters.action) query = query.eq('action', filters.action);

  const { data, error } = await query;
  if (error) {
    console.error('[listAuditLog] DB error:', error.message);
    return [];
  }
  return (data ?? []) as AuditLogRow[];
}
