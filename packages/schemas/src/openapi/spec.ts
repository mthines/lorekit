// deno-lint-ignore-file
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { MemoryEntrySchema, CreateMemoryBodySchema, UpdateMemoryBodySchema, SearchMemoriesBodySchema, ListMemoriesQuerySchema } from '../memory.ts';
import { OrgResponseSchema, CreateOrgBodySchema, RenameOrgBodySchema } from '../org.ts';
import { OrgMemberSchema, UpdateMemberRoleBodySchema } from '../member.ts';
import { OrgInviteSchema, CreateInviteBodySchema } from '../invite.ts';
import { ErrorResponseSchema } from '../common.ts';

let _cachedSpec: Record<string, unknown> | null = null;

export function generateSpec(baseUrl = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1'): Record<string, unknown> {
  if (_cachedSpec) return _cachedSpec;

  const registry = new OpenAPIRegistry();

  registry.register('Memory', MemoryEntrySchema);
  registry.register('CreateMemoryBody', CreateMemoryBodySchema);
  registry.register('UpdateMemoryBody', UpdateMemoryBodySchema);
  registry.register('SearchMemoriesBody', SearchMemoriesBodySchema);
  registry.register('Org', OrgResponseSchema);
  registry.register('CreateOrgBody', CreateOrgBodySchema);
  registry.register('OrgMember', OrgMemberSchema);
  registry.register('OrgInvite', OrgInviteSchema);
  registry.register('Error', ErrorResponseSchema);

  const bearerAuth = registry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http', scheme: 'bearer',
    description: 'LoreKit API token (lk_rw_*, lk_ro_*) or Supabase JWT. Org endpoints require JWT.',
  });

  const security = [{ [bearerAuth.name]: [] }];
  const errorResponse = { description: 'Error', content: { 'application/json': { schema: ErrorResponseSchema } } };
  const memoryResponse = (_status: number, desc: string) => ({ description: desc, content: { 'application/json': { schema: MemoryEntrySchema } } });
  const pageResponse = (desc: string) => ({ description: desc, content: { 'application/json': { schema: z.object({ entries: z.array(MemoryEntrySchema), hasMore: z.boolean(), nextCursor: z.string().nullable() }) } } });

  registry.registerPath({ method: 'get', path: '/api-memories', summary: 'List memories', tags: ['Memories'], security, request: { query: ListMemoriesQuerySchema }, responses: { 200: pageResponse('Paginated memories'), 401: errorResponse, 403: errorResponse } });
  registry.registerPath({ method: 'post', path: '/api-memories', summary: 'Create or update a memory', tags: ['Memories'], security, request: { body: { content: { 'application/json': { schema: CreateMemoryBodySchema } } } }, responses: { 201: memoryResponse(201, 'Created'), 400: errorResponse, 401: errorResponse, 429: errorResponse } });
  registry.registerPath({ method: 'get', path: '/api-memories/{id}', summary: 'Get memory by ID', tags: ['Memories'], security, request: { params: z.object({ id: z.string().uuid() }) }, responses: { 200: memoryResponse(200, 'Memory'), 404: errorResponse } });
  registry.registerPath({ method: 'patch', path: '/api-memories/{id}', summary: 'Update a memory', tags: ['Memories'], security, request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: UpdateMemoryBodySchema } } } }, responses: { 200: memoryResponse(200, 'Updated memory'), 400: errorResponse, 404: errorResponse } });
  registry.registerPath({ method: 'delete', path: '/api-memories/{id}', summary: 'Archive a memory (soft-delete)', tags: ['Memories'], security, request: { params: z.object({ id: z.string().uuid() }) }, responses: { 204: { description: 'Archived' }, 404: errorResponse } });
  registry.registerPath({ method: 'post', path: '/api-memories/search', summary: 'Search memories with OR+AND filtering', tags: ['Memories'], security, request: { body: { content: { 'application/json': { schema: SearchMemoriesBodySchema } } } }, responses: { 200: pageResponse('Search results'), 400: errorResponse } });
  registry.registerPath({ method: 'get', path: '/api-orgs', summary: 'List my organizations (JWT only)', tags: ['Orgs'], security, responses: { 200: { description: 'Orgs', content: { 'application/json': { schema: z.object({ entries: z.array(OrgResponseSchema) }) } } }, 401: errorResponse } });
  registry.registerPath({ method: 'post', path: '/api-orgs', summary: 'Create an organization (JWT only)', tags: ['Orgs'], security, request: { body: { content: { 'application/json': { schema: CreateOrgBodySchema } } } }, responses: { 201: { description: 'Created org', content: { 'application/json': { schema: OrgResponseSchema } } }, 403: errorResponse } });
  registry.registerPath({ method: 'get', path: '/api-orgs/{slug}', summary: 'Get organization (JWT only)', tags: ['Orgs'], security, request: { params: z.object({ slug: z.string() }) }, responses: { 200: { description: 'Org', content: { 'application/json': { schema: OrgResponseSchema } } }, 404: errorResponse } });
  registry.registerPath({ method: 'patch', path: '/api-orgs/{slug}', summary: 'Rename organization (JWT only)', tags: ['Orgs'], security, request: { params: z.object({ slug: z.string() }), body: { content: { 'application/json': { schema: RenameOrgBodySchema } } } }, responses: { 200: { description: 'Updated org', content: { 'application/json': { schema: OrgResponseSchema } } } } });
  registry.registerPath({ method: 'delete', path: '/api-orgs/{slug}', summary: 'Delete organization — owner only (JWT only)', tags: ['Orgs'], security, request: { params: z.object({ slug: z.string() }) }, responses: { 204: { description: 'Deleted' }, 403: errorResponse } });
  registry.registerPath({ method: 'get', path: '/api-orgs/{slug}/members', summary: 'List members (JWT only)', tags: ['Members'], security, request: { params: z.object({ slug: z.string() }) }, responses: { 200: { description: 'Members', content: { 'application/json': { schema: z.object({ entries: z.array(OrgMemberSchema) }) } } } } });
  registry.registerPath({ method: 'patch', path: '/api-orgs/{slug}/members/{userId}', summary: 'Update member role (JWT only)', tags: ['Members'], security, request: { params: z.object({ slug: z.string(), userId: z.string().uuid() }), body: { content: { 'application/json': { schema: UpdateMemberRoleBodySchema } } } }, responses: { 200: { description: 'Updated' } } });
  registry.registerPath({ method: 'delete', path: '/api-orgs/{slug}/members/{userId}', summary: 'Remove member (JWT only)', tags: ['Members'], security, request: { params: z.object({ slug: z.string(), userId: z.string().uuid() }) }, responses: { 204: { description: 'Removed' } } });
  registry.registerPath({ method: 'get', path: '/api-orgs/{slug}/invites', summary: 'List pending invites (JWT only)', tags: ['Invites'], security, request: { params: z.object({ slug: z.string() }) }, responses: { 200: { description: 'Invites', content: { 'application/json': { schema: z.object({ entries: z.array(OrgInviteSchema) }) } } } } });
  registry.registerPath({ method: 'post', path: '/api-orgs/{slug}/invites', summary: 'Send an invite (JWT only)', tags: ['Invites'], security, request: { params: z.object({ slug: z.string() }), body: { content: { 'application/json': { schema: CreateInviteBodySchema } } } }, responses: { 201: { description: 'Invite sent', content: { 'application/json': { schema: OrgInviteSchema } } } } });
  registry.registerPath({ method: 'delete', path: '/api-orgs/{slug}/invites/{inviteId}', summary: 'Revoke an invite (JWT only)', tags: ['Invites'], security, request: { params: z.object({ slug: z.string(), inviteId: z.string().uuid() }) }, responses: { 204: { description: 'Revoked' } } });

  const gen = new OpenApiGeneratorV31(registry.definitions);
  _cachedSpec = gen.generateDocument({
    openapi: '3.1.0',
    info: { title: 'LoreKit REST API', version: '1.0.0', description: 'Persistent memory for AI coding agents.' },
    servers: [{ url: baseUrl, description: 'Supabase Edge Functions' }],
  }) as unknown as Record<string, unknown>;

  return _cachedSpec;
}
