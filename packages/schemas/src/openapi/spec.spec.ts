import { describe, expect, it } from 'vitest';
import { generateSpec } from './spec.ts';

// `generateSpec` had never been executed by any test, and it threw on its very first
// `registry.register()` call — so GET /functions/v1/openapi returned 500 in production
// from the day it shipped. These assertions run the real generator: any schema that
// zod-to-openapi cannot introspect (a new `z.lazy()`, a bare `z.custom()`, …) fails here
// instead of at runtime on the deployed function.
describe('generateSpec', () => {
  const spec = generateSpec('https://example.test/functions/v1') as {
    openapi: string;
    servers: Array<{ url: string }>;
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  };

  it('produces an OpenAPI 3.1 document for the given base URL', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('https://example.test/functions/v1');
  });

  it('documents every REST route the edge functions serve', () => {
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/memories',
      '/memories/purge',
      '/memories/purge-expired',
      '/memories/restore',
      '/memories/scopes',
      '/memories/search',
      '/memories/{id}',
      '/memories/{id}/restore',
      '/orgs',
      '/orgs/{slug}',
      '/orgs/{slug}/invites',
      '/orgs/{slug}/invites/{inviteId}',
      '/orgs/{slug}/members',
      '/orgs/{slug}/members/{userId}',
    ]);
  });

  it('registers every named component schema', () => {
    for (const name of [
      'Memory',
      'MemoryPage',
      'CreateMemoryBody',
      'UpdateMemoryBody',
      'SearchMemoriesBody',
      'RestoreMemoryBody',
      'PurgeMemoriesBody',
      'RestoreResponse',
      'PurgeResponse',
      'ScopesResponse',
      'Org',
      'OrgList',
      'CreateOrgBody',
      'RenameOrgBody',
      'OrgMember',
      'OrgMemberList',
      'UpdateMemberRoleBody',
      'OrgInvite',
      'OrgInviteList',
      'CreateInviteBody',
      'Error',
    ]) {
      expect(spec.components.schemas[name], `missing component: ${name}`).toBeDefined();
    }
    // One scheme: a Bearer credential (lk_* API token or Supabase JWT) works on
    // every endpoint, so the docs need a single Authorize field the user fills once.
    expect(spec.components.securitySchemes.BearerAuth).toBeDefined();
  });

  // Dry-run safety flag: the docs default `X-LoreKit-Dry-Run` to true on every
  // mutating operation, and never attach it to a read.
  it('attaches the dry-run header to mutating operations only', () => {
    const post = spec.paths['/memories']!.post as { parameters?: Array<{ name: string; in: string; schema?: { default?: unknown } }> };
    const dryRun = post.parameters?.find((p) => p.name === 'X-LoreKit-Dry-Run');
    expect(dryRun, 'POST /memories must document X-LoreKit-Dry-Run').toBeDefined();
    expect(dryRun?.in).toBe('header');
    expect(dryRun?.schema?.default).toBe(true);

    const get = spec.paths['/memories']!.get as { parameters?: Array<{ name: string }> };
    expect((get.parameters ?? []).some((p) => p.name === 'X-LoreKit-Dry-Run')).toBe(false);
  });

  // The hard-delete flag is a query param on BOTH delete forms — a caller that
  // reads only the spec must be able to discover it, since it is the difference
  // between an archive and an irreversible delete.
  it.each(['/memories', '/memories/{id}'])('documents ?force=true on DELETE %s', (path) => {
    const del = spec.paths[path]!.delete as { parameters: Array<{ name: string; in: string }> };
    expect(del.parameters.some((p) => p.name === 'force' && p.in === 'query'), JSON.stringify(del.parameters)).toBe(true);
  });

  // `?org=<slug>` is the only way to archive or hard-delete ORG-OWNED lore over
  // REST — it routes through the role-gated memory_delete RPC instead of a
  // direct query. Undiscoverable in the spec means unusable by a REST client,
  // which was exactly the gap this closed.
  it.each(['/memories', '/memories/{id}'])('documents ?org=<slug> on DELETE %s', (path) => {
    const del = spec.paths[path]!.delete as {
      parameters: Array<{ name: string; in: string; required?: boolean; schema?: { type?: string } }>;
    };
    const org = del.parameters.find((p) => p.name === 'org' && p.in === 'query');
    expect(org, JSON.stringify(del.parameters)).toBeDefined();
    // Optional — every existing caller omits it and must keep working.
    expect(org!.required ?? false).toBe(false);
    expect(org!.schema?.type).toBe('string');
  });

  // A role denial inside memory_delete is SQLSTATE LK002, which translateDbError
  // maps to a 403. A caller reading only the spec must know that DELETE can now
  // answer 403, not just 400/401/404.
  it('documents a 403 on DELETE /memories (org role denial)', () => {
    const del = spec.paths['/memories']!.delete as { responses: Record<string, unknown> };
    expect(Object.keys(del.responses)).toContain('403');
  });

  // The org REST routes accept lk_* tokens as of migration 00041; the security
  // scheme must not still tell readers they need a JWT.
  it('does not claim org endpoints are JWT-only', () => {
    const scheme = spec.components.securitySchemes.BearerAuth as { description?: string };
    expect(scheme.description).toBeDefined();
    expect(scheme.description!.toLowerCase()).not.toContain('org endpoints require jwt');
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const summary = (op as { summary?: string }).summary ?? '';
        expect(summary, `${method.toUpperCase()} ${path}`).not.toContain('JWT only');
      }
    }
  });

  it('documents a response body for every new memory endpoint', () => {
    for (const [path, method] of [
      ['/memories/restore', 'post'],
      ['/memories/{id}/restore', 'post'],
      ['/memories/purge', 'post'],
      ['/memories/purge-expired', 'post'],
      ['/memories/scopes', 'get'],
    ] as const) {
      const op = spec.paths[path]![method] as { responses: Record<string, { content?: unknown }> };
      expect(op.responses['200']?.content, `${method.toUpperCase()} ${path} has no 200 body`).toBeDefined();
    }
  });

  // The doc schema is derived from the runtime one, so a field added to
  // SearchMemoriesBodySchema must appear here without touching spec.ts.
  it('documents the recursive search filter as a free-form object', () => {
    const body = spec.components.schemas.SearchMemoriesBody as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(Object.keys(body.properties).sort()).toEqual(['cursor', 'filter', 'limit', 'q', 'scopes', 'tags']);
    expect(body.properties.filter.type).toBe('object');
    expect(body.properties.filter.description).toContain('Recursive filter tree');
  });
});
