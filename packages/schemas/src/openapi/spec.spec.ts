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
    expect(spec.components.securitySchemes.BearerAuth).toBeDefined();
  });

  // The hard-delete flag is a query param on BOTH delete forms — a caller that
  // reads only the spec must be able to discover it, since it is the difference
  // between an archive and an irreversible delete.
  it.each(['/memories', '/memories/{id}'])('documents ?force=true on DELETE %s', (path) => {
    const del = spec.paths[path]!.delete as { parameters: Array<{ name: string; in: string }> };
    expect(del.parameters.some((p) => p.name === 'force' && p.in === 'query'), JSON.stringify(del.parameters)).toBe(true);
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
