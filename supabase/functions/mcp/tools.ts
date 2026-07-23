/**
 * MCP tool handlers — one function per memory.* tool.
 *
 * SECURITY: When userId is provided (api_key auth), every query MUST include
 * .eq('user_id', userId). The service-role client bypasses RLS — without this
 * filter, users could access each other's memories.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateScope } from '../_shared/scope.ts';
import { traceRequest, createTracedClient, type Span } from '../_shared/otel.ts';

export const MAX_VALUE_BYTES = 65_536;

// deno-lint-ignore no-explicit-any
export type Params = Record<string, any>;

export async function toolWrite(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { scope: rawScope, key, value, tags = [], source_agent, trigger } = params;
  if (!rawScope || !key || !value) throw new Error('scope, key, and value are required');
  if (value.length > MAX_VALUE_BYTES) throw new Error(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });
  if (source_agent) span.setAttributes({ 'lorekit.source_agent': source_agent });
  if (trigger) span.setAttributes({ 'lorekit.trigger': trigger });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .from('memories')
    .upsert(
      {
        ...(userId ? { user_id: userId } : {}),
        scope, key, value, tags,
        source_agent: source_agent ?? null,
        trigger: trigger ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,scope,key' },
    )
    .select('id,created_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function toolRead(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb.from('memories').select('value,updated_at').eq('scope', scope).eq('key', key);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function toolList(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { scope: rawScope, tags, limit = 50 } = params;
  if (!rawScope) throw new Error('scope is required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb
    .from('memories')
    .select('key,value,tags,updated_at')
    .eq('scope', scope)
    .order('updated_at', { ascending: false })
    .limit(Math.min(limit, 100));
  if (userId) query = query.eq('user_id', userId);
  if (tags?.length) query = query.overlaps('tags', tags);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const entries = data ?? [];
  span.setAttributes({ 'lorekit.result.count': entries.length });
  return { entries };
}

export async function toolDelete(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { scope: rawScope, key } = params;
  if (!rawScope || !key) throw new Error('scope and key are required');
  const scope = validateScope(rawScope);

  span.setAttributes({ 'lorekit.scope': scope, 'lorekit.key': key });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb.from('memories').delete({ count: 'exact' }).eq('scope', scope).eq('key', key);
  if (userId) query = query.eq('user_id', userId);
  const { error, count } = await query;
  if (error) throw new Error(error.message);
  const deleted = (count ?? 0) > 0;
  span.setAttributes({ 'lorekit.result.deleted': deleted });
  return { deleted };
}

export async function toolSearch(
  db: ReturnType<typeof createClient>,
  params: Params,
  userId: string | null,
  span: Span,
) {
  const { q, scopes, tags, limit = 20 } = params;
  if (!q) throw new Error('q is required');

  span.setAttributes({ 'lorekit.search.query': q });

  const tracedDb = createTracedClient(db, span);
  let query = tracedDb
    .from('memories')
    .select('key,value,scope,tags')
    .textSearch('fts', q, { type: 'websearch', config: 'english' })
    .limit(Math.min(limit, 100));
  if (userId) query = query.eq('user_id', userId);
  if (tags?.length) query = query.overlaps('tags', tags);
  if (scopes?.length) {
    const exactScopes: string[] = [];
    const likePatterns: string[] = [];
    for (const s of scopes) {
      if (s.endsWith('/*') || s.endsWith('::*')) {
        likePatterns.push(s.replace(/\*$/, '%'));
      } else {
        try { exactScopes.push(validateScope(s)); } catch { /* skip invalid */ }
      }
    }
    const orParts: string[] = [];
    if (exactScopes.length) orParts.push(`scope.in.(${exactScopes.map((s) => `"${s}"`).join(',')})`);
    likePatterns.forEach((p) => orParts.push(`scope.like.${p}`));
    if (orParts.length) query = query.or(orParts.join(','));
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const entries = (data ?? []).map((row, i) => ({ ...row, rank: 1 - i * 0.05 }));
  span.setAttributes({ 'lorekit.result.count': entries.length });
  return { entries };
}
