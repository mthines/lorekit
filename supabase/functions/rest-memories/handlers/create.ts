/**
 * POST /rest-memories
 *
 * Creates or updates (upserts) a memory at the given scope+key.
 * Uses the memory_write RPC — same as the MCP memory.write tool.
 *
 * Request body: WriteInputSchema fields (scope, key, value, tags?, org?, ttl_days?, ...)
 * Response: { id, created_at, expires_at? }
 *   - 201 when a new memory was created
 *   - 200 when an existing memory was updated
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthContext, getUserId } from '../../_shared/api/auth.ts';
import { ok, created, tooManyRequests, badRequest, fromError } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { checkRateLimit } from '../../_shared/api/rate-limit.ts';
import { WriteInputSchema } from '../../_shared/schemas/memory.ts';
import { createTracedClient, type Span } from '../../_shared/otel.ts';
import { validateScope } from '../../_shared/scope.ts';
import { translateOrgPermissionError } from '../../_shared/api/org-errors.ts';
import { MEMORY_CAP_SQLSTATE } from '../../_shared/api/limit-errors.ts';

export async function handleCreate(
  req: Request,
  auth: AuthContext,
  db: ReturnType<typeof createClient>,
  span: Span,
  _params: Record<string, string>,
): Promise<Response> {
  const parsed = await validateBody(req, WriteInputSchema);
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;

  // Validate scope
  let scope: string;
  try {
    scope = validateScope(input.scope);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  span.setAttributes({
    'lorekit.rest.action': 'create',
    'lorekit.scope': scope,
    'lorekit.key': input.key,
  });

  try {
    const userId = getUserId(auth);

    // Rate limit check (service-role exempt via userId=null)
    const rl = await checkRateLimit(db, userId, span);
    if (!rl.allowed) {
      return tooManyRequests(
        rl.retryAfterSeconds,
        `Rate limited. Retry after ${rl.retryAfterSeconds}s.`,
      );
    }

    const tracedDb = createTracedClient(db, span);

    // Parse optional fields
    let createdAt: string | null = null;
    if (input.created_at) {
      const ts = new Date(input.created_at);
      if (isNaN(ts.getTime())) {
        return badRequest('created_at must be a valid ISO 8601 timestamp');
      }
      if (ts > new Date(Date.now() + 60_000)) {
        return badRequest('created_at must not be in the future');
      }
      createdAt = ts.toISOString();
    }

    const ttlDays = input.ttl_days ?? null;

    const { data, error } = await tracedDb
      .rpc('memory_write', {
        p_user_id: userId,
        p_scope: scope,
        p_key: input.key,
        p_value: input.value,
        p_tags: input.tags ?? [],
        p_source_agent: input.source_agent ?? null,
        p_trigger: input.trigger ?? null,
        p_created_at: createdAt,
        p_org_slug: input.org ?? null,
        p_ttl_days: ttlDays,
        p_clear_ttl: input.clear_ttl ?? false,
      })
      .single();

    if (error) {
      // Memory cap exceeded
      if ((error as { code?: string }).code === MEMORY_CAP_SQLSTATE) {
        return tooManyRequests(0, 'Memory cap exceeded. Archive or delete unused memories.');
      }
      // Org permission denied
      const translated = translateOrgPermissionError(error);
      if (translated instanceof Error) {
        return badRequest(translated.message);
      }
      return fromError(error, 'create');
    }

    const row = data as {
      id: string;
      created_at: string;
      inserted?: boolean;
      expires_at?: string | null;
    };

    span.setAttributes({ 'lorekit.memory.id': row.id, 'lorekit.memory.inserted': row.inserted ?? true });

    const result: Record<string, unknown> = { id: row.id, created_at: row.created_at };
    if (ttlDays !== null || input.clear_ttl) result['expires_at'] = row.expires_at ?? null;

    // 201 Created for new rows, 200 OK for updates
    return row.inserted === false ? ok(result) : created(result);
  } catch (err) {
    return fromError(err, 'create');
  }
}
