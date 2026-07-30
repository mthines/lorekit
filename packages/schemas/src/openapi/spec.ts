// deno-lint-ignore-file
import { z } from 'zod';
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// zod-to-openapi v7 attaches `.openapi()` to ZodType.prototype. Without this call
// every `registry.register()` throws `zodSchema.openapi is not a function`, which is
// what made GET /functions/v1/openapi return 500 from the day it shipped. The patch is
// applied here (the only module that talks to zod-to-openapi) so the runtime schema
// files stay free of any OpenAPI dependency — the edge functions that import them do
// not pull zod-to-openapi into their bundle.
extendZodWithOpenApi(z);

import {
  MemoryEntrySchema,
  MemoryPageResponseSchema,
  CreateMemoryBodySchema,
  UpdateMemoryBodySchema,
  SearchMemoriesBodySchema,
  ListMemoriesQuerySchema,
} from '../memory.ts';
import {
  OrgResponseSchema,
  OrgListResponseSchema,
  CreateOrgBodySchema,
  RenameOrgBodySchema,
} from '../org.ts';
import {
  OrgMemberSchema,
  OrgMemberListResponseSchema,
  UpdateMemberRoleBodySchema,
} from '../member.ts';
import {
  OrgInviteSchema,
  OrgInviteListResponseSchema,
  CreateInviteBodySchema,
} from '../invite.ts';
import {
  ErrorResponseSchema,
  MemoryIdParamsSchema,
  OrgSlugParamsSchema,
  OrgSlugMemberParamsSchema,
  OrgSlugInviteParamsSchema,
} from '../common.ts';

let _cachedSpec: Record<string, unknown> | null = null;

// `FilterGroupSchema` is a `z.lazy()` recursive union, which zod-to-openapi cannot
// introspect ("Unknown zod object type"). Document it as a free-form object with an
// example instead of duplicating the search body: the doc schema is DERIVED from the
// runtime one (`.innerType()` unwraps the `.refine()` wrapper), so any field added to
// `SearchMemoriesBodySchema` shows up here automatically — only `filter` is overridden.
const FilterGroupDocSchema = z.record(z.unknown()).openapi({
  type: 'object',
  description:
    'Recursive filter tree. Either a condition `{ field, op, value }` or a group ' +
    '`{ and: [...] }` / `{ or: [...] }`, nestable to any depth. ' +
    'Operators: is, is_not, contains, does_not_contain, starts_with, ends_with, is_set, is_not_set.',
  example: {
    and: [
      { field: 'scope', op: 'is', value: 'global' },
      { or: [{ field: 'key', op: 'contains', value: 'auth' }, { field: 'tags', op: 'contains', value: 'ci' }] },
    ],
  },
});

const SearchMemoriesBodyDocSchema = SearchMemoriesBodySchema.innerType().extend({
  filter: FilterGroupDocSchema.optional(),
});

export function generateSpec(baseUrl = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1'): Record<string, unknown> {
  if (_cachedSpec) return _cachedSpec;

  const registry = new OpenAPIRegistry();

  // Register all schemas so they appear as $ref components in the spec.
  // Every schema used in a path must be registered here first.
  registry.register('Memory', MemoryEntrySchema);
  registry.register('MemoryPage', MemoryPageResponseSchema);
  registry.register('CreateMemoryBody', CreateMemoryBodySchema);
  registry.register('UpdateMemoryBody', UpdateMemoryBodySchema);
  registry.register('SearchMemoriesBody', SearchMemoriesBodyDocSchema);
  registry.register('Org', OrgResponseSchema);
  registry.register('OrgList', OrgListResponseSchema);
  registry.register('CreateOrgBody', CreateOrgBodySchema);
  registry.register('RenameOrgBody', RenameOrgBodySchema);
  registry.register('OrgMember', OrgMemberSchema);
  registry.register('OrgMemberList', OrgMemberListResponseSchema);
  registry.register('UpdateMemberRoleBody', UpdateMemberRoleBodySchema);
  registry.register('OrgInvite', OrgInviteSchema);
  registry.register('OrgInviteList', OrgInviteListResponseSchema);
  registry.register('CreateInviteBody', CreateInviteBodySchema);
  registry.register('Error', ErrorResponseSchema);

  const bearerAuth = registry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'LoreKit API token (lk_rw_*, lk_ro_*) or Supabase JWT. Org endpoints require JWT.',
  });

  const security = [{ [bearerAuth.name]: [] }];

  const errorResponse = {
    description: 'Error',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  };
  const memoryResponse = (desc: string) => ({
    description: desc,
    content: { 'application/json': { schema: MemoryEntrySchema } },
  });
  const memoryPageResponse = (desc: string) => ({
    description: desc,
    content: { 'application/json': { schema: MemoryPageResponseSchema } },
  });

  // ── Memories ──────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get', path: '/memories', summary: 'List memories', tags: ['Memories'],
    security, request: { query: ListMemoriesQuerySchema },
    responses: { 200: memoryPageResponse('Paginated memories'), 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/memories', summary: 'Create or update a memory', tags: ['Memories'],
    security, request: { body: { content: { 'application/json': { schema: CreateMemoryBodySchema } } } },
    responses: { 201: memoryResponse('Created'), 400: errorResponse, 401: errorResponse, 429: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/memories/search', summary: 'Search memories with OR+AND filtering', tags: ['Memories'],
    security, request: { body: { content: { 'application/json': { schema: SearchMemoriesBodyDocSchema } } } },
    responses: { 200: memoryPageResponse('Search results'), 400: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'get', path: '/memories/{id}', summary: 'Get memory by ID', tags: ['Memories'],
    security, request: { params: MemoryIdParamsSchema },
    responses: { 200: memoryResponse('Memory'), 404: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'patch', path: '/memories/{id}', summary: 'Update a memory', tags: ['Memories'],
    security,
    request: {
      params: MemoryIdParamsSchema,
      body: { content: { 'application/json': { schema: UpdateMemoryBodySchema } } },
    },
    responses: { 200: memoryResponse('Updated memory'), 400: errorResponse, 404: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/memories/{id}', summary: 'Archive a memory (soft-delete)', tags: ['Memories'],
    security, request: { params: MemoryIdParamsSchema },
    responses: { 204: { description: 'Archived' }, 404: errorResponse, 401: errorResponse },
  });

  // ── Orgs ─────────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get', path: '/orgs', summary: 'List my organizations (JWT only)', tags: ['Orgs'],
    security,
    responses: { 200: { description: 'Orgs', content: { 'application/json': { schema: OrgListResponseSchema } } }, 401: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/orgs', summary: 'Create an organization (JWT only)', tags: ['Orgs'],
    security, request: { body: { content: { 'application/json': { schema: CreateOrgBodySchema } } } },
    responses: { 201: { description: 'Created org', content: { 'application/json': { schema: OrgResponseSchema } } }, 400: errorResponse, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'get', path: '/orgs/{slug}', summary: 'Get organization (JWT only)', tags: ['Orgs'],
    security, request: { params: OrgSlugParamsSchema },
    responses: { 200: { description: 'Org', content: { 'application/json': { schema: OrgResponseSchema } } }, 404: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'patch', path: '/orgs/{slug}', summary: 'Rename organization (JWT only)', tags: ['Orgs'],
    security,
    request: { params: OrgSlugParamsSchema, body: { content: { 'application/json': { schema: RenameOrgBodySchema } } } },
    responses: { 200: { description: 'Updated org', content: { 'application/json': { schema: OrgResponseSchema } } }, 400: errorResponse, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/orgs/{slug}', summary: 'Delete organization — owner only (JWT only)', tags: ['Orgs'],
    security, request: { params: OrgSlugParamsSchema },
    responses: { 204: { description: 'Deleted' }, 401: errorResponse, 403: errorResponse },
  });

  // ── Members ───────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get', path: '/orgs/{slug}/members', summary: 'List members (JWT only)', tags: ['Members'],
    security, request: { params: OrgSlugParamsSchema },
    responses: { 200: { description: 'Members', content: { 'application/json': { schema: OrgMemberListResponseSchema } } }, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'patch', path: '/orgs/{slug}/members/{userId}', summary: 'Update member role (JWT only)', tags: ['Members'],
    security,
    request: {
      params: OrgSlugMemberParamsSchema,
      body: { content: { 'application/json': { schema: UpdateMemberRoleBodySchema } } },
    },
    responses: { 200: { description: 'Updated' }, 400: errorResponse, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/orgs/{slug}/members/{userId}', summary: 'Remove member (JWT only)', tags: ['Members'],
    security, request: { params: OrgSlugMemberParamsSchema },
    responses: { 204: { description: 'Removed' }, 401: errorResponse, 403: errorResponse },
  });

  // ── Invites ───────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get', path: '/orgs/{slug}/invites', summary: 'List pending invites (JWT only)', tags: ['Invites'],
    security, request: { params: OrgSlugParamsSchema },
    responses: { 200: { description: 'Invites', content: { 'application/json': { schema: OrgInviteListResponseSchema } } }, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/orgs/{slug}/invites', summary: 'Send an invite (JWT only)', tags: ['Invites'],
    security,
    request: { params: OrgSlugParamsSchema, body: { content: { 'application/json': { schema: CreateInviteBodySchema } } } },
    responses: { 201: { description: 'Invite sent', content: { 'application/json': { schema: OrgInviteSchema } } }, 400: errorResponse, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/orgs/{slug}/invites/{inviteId}', summary: 'Revoke an invite (JWT only)', tags: ['Invites'],
    security, request: { params: OrgSlugInviteParamsSchema },
    responses: { 204: { description: 'Revoked' }, 401: errorResponse, 403: errorResponse },
  });

  const gen = new OpenApiGeneratorV31(registry.definitions);
  _cachedSpec = gen.generateDocument({
    openapi: '3.1.0',
    info: { title: 'LoreKit REST API', version: '1.0.0', description: 'Persistent memory for AI coding agents.' },
    servers: [{ url: baseUrl, description: 'Supabase Edge Functions' }],
  }) as unknown as Record<string, unknown>;

  return _cachedSpec;
}
