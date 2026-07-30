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
      '/memories/search',
      '/memories/{id}',
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
