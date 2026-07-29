/**
 * OpenAPI 3.1 spec generator.
 *
 * Builds the full OpenAPI document from Zod schemas using
 * @asteasolutions/zod-to-openapi. Called at runtime by the rest-openapi
 * edge function (one generation per isolate cold-start, then cached in
 * module scope). Also used by the generate.ts script for a static artifact.
 *
 * Adding a new endpoint:
 *   1. Define Zod schemas in the appropriate src/*.ts file
 *   2. Register them and the route in this file
 *   3. Run `pnpm nx generate:openapi schemas` to update dist/openapi.json
 */

import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import {
  MemoryResponseSchema,
  WriteInputSchema,
  MemoryUpdateSchema,
  MemorySearchBodySchema,
  MemoryWriteResponseSchema,
  MemoryListParamsSchema,
} from '../memory.js';
import {
  OrgResponseSchema,
  OrgCreateSchema,
  OrgRenameSchema,
  MemberResponseSchema,
  MemberRoleUpdateSchema,
  InviteResponseSchema,
  InviteCreateSchema,
} from '../org.js';
import { ErrorResponseSchema, paginatedResponse } from '../common.js';

const registry = new OpenAPIRegistry();

// ── Register component schemas ────────────────────────────────────────────────

registry.register('Memory', MemoryResponseSchema);
registry.register('MemoryWrite', WriteInputSchema);
registry.register('MemoryUpdate', MemoryUpdateSchema);
registry.register('MemorySearch', MemorySearchBodySchema);
registry.register('MemoryWriteResponse', MemoryWriteResponseSchema);
registry.register('MemoryPage', paginatedResponse(MemoryResponseSchema));

registry.register('Org', OrgResponseSchema);
registry.register('OrgCreate', OrgCreateSchema);
registry.register('OrgRename', OrgRenameSchema);
registry.register('Member', MemberResponseSchema);
registry.register('MemberRoleUpdate', MemberRoleUpdateSchema);
registry.register('Invite', InviteResponseSchema);
registry.register('InviteCreate', InviteCreateSchema);

registry.register('Error', ErrorResponseSchema);

// ── Register routes ───────────────────────────────────────────────────────────

// Memories
registry.registerPath({
  method: 'get', path: '/rest-memories',
  summary: 'List memories',
  description: 'Paginated list. Filter by scope, key, tags, org. For complex OR+AND use POST /rest-memories/search.',
  request: { query: MemoryListParamsSchema },
  responses: {
    200: { description: 'Paginated memories', content: { 'application/json': { schema: paginatedResponse(MemoryResponseSchema) } } },
    400: { description: 'Bad request', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    429: { description: 'Rate limited' },
  },
});

registry.registerPath({
  method: 'post', path: '/rest-memories',
  summary: 'Create or update a memory',
  request: { body: { content: { 'application/json': { schema: WriteInputSchema } } } },
  responses: {
    200: { description: 'Memory updated', content: { 'application/json': { schema: MemoryWriteResponseSchema } } },
    201: { description: 'Memory created', content: { 'application/json': { schema: MemoryWriteResponseSchema } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    429: { description: 'Rate limit or memory cap exceeded' },
  },
});

registry.registerPath({
  method: 'get', path: '/rest-memories/{id}',
  summary: 'Get a memory by UUID',
  responses: {
    200: { description: 'Memory', content: { 'application/json': { schema: MemoryResponseSchema } } },
    401: { description: 'Unauthorized' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'patch', path: '/rest-memories/{id}',
  summary: 'Update a memory (partial)',
  request: { body: { content: { 'application/json': { schema: MemoryUpdateSchema } } } },
  responses: {
    200: { description: 'Updated memory', content: { 'application/json': { schema: MemoryResponseSchema } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'delete', path: '/rest-memories/{id}',
  summary: 'Archive (soft-delete) a memory',
  description: 'Sets archived_at. Add ?force=true to hard-delete permanently.',
  responses: {
    204: { description: 'Archived or deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'post', path: '/rest-memories/search',
  summary: 'Search memories',
  description: 'Full-text search + scope/tag filters with pagination.',
  request: { body: { content: { 'application/json': { schema: MemorySearchBodySchema } } } },
  responses: {
    200: { description: 'Search results', content: { 'application/json': { schema: paginatedResponse(MemoryResponseSchema) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized' },
    429: { description: 'Rate limited' },
  },
});

// Orgs
registry.registerPath({
  method: 'get', path: '/rest-orgs',
  summary: 'List orgs the caller belongs to',
  responses: {
    200: { description: 'Orgs', content: { 'application/json': { schema: paginatedResponse(OrgResponseSchema) } } },
    401: { description: 'JWT required (no API key)' },
  },
});

registry.registerPath({
  method: 'post', path: '/rest-orgs',
  summary: 'Create an org',
  request: { body: { content: { 'application/json': { schema: OrgCreateSchema } } } },
  responses: {
    201: { description: 'Created', content: { 'application/json': { schema: OrgResponseSchema } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'JWT required' },
  },
});

registry.registerPath({
  method: 'get', path: '/rest-orgs/{slug}',
  summary: 'Get an org',
  responses: {
    200: { description: 'Org', content: { 'application/json': { schema: OrgResponseSchema } } },
    401: { description: 'JWT required' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'patch', path: '/rest-orgs/{slug}',
  summary: 'Rename an org (admin/owner)',
  request: { body: { content: { 'application/json': { schema: OrgRenameSchema } } } },
  responses: {
    200: { description: 'Updated', content: { 'application/json': { schema: OrgResponseSchema } } },
    401: { description: 'JWT required' },
    403: { description: 'Insufficient role' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'delete', path: '/rest-orgs/{slug}',
  summary: 'Soft-delete an org (owner only)',
  responses: {
    204: { description: 'Deleted' },
    401: { description: 'JWT required' },
    403: { description: 'Insufficient role' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'get', path: '/rest-orgs/{slug}/members',
  summary: 'List org members',
  responses: {
    200: { description: 'Members', content: { 'application/json': { schema: paginatedResponse(MemberResponseSchema) } } },
    401: { description: 'JWT required' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'patch', path: '/rest-orgs/{slug}/members/{userId}',
  summary: 'Change a member role (admin/owner)',
  request: { body: { content: { 'application/json': { schema: MemberRoleUpdateSchema } } } },
  responses: {
    200: { description: 'Updated', content: { 'application/json': { schema: MemberResponseSchema } } },
    401: { description: 'JWT required' },
    403: { description: 'Insufficient role' },
  },
});

registry.registerPath({
  method: 'delete', path: '/rest-orgs/{slug}/members/{userId}',
  summary: 'Remove a member',
  responses: {
    204: { description: 'Removed' },
    401: { description: 'JWT required' },
    403: { description: 'Insufficient role' },
  },
});

registry.registerPath({
  method: 'get', path: '/rest-orgs/{slug}/invites',
  summary: 'List pending invites',
  responses: {
    200: { description: 'Invites', content: { 'application/json': { schema: paginatedResponse(InviteResponseSchema) } } },
    401: { description: 'JWT required' },
  },
});

registry.registerPath({
  method: 'post', path: '/rest-orgs/{slug}/invites',
  summary: 'Send an invite (admin/owner)',
  request: { body: { content: { 'application/json': { schema: InviteCreateSchema } } } },
  responses: {
    201: { description: 'Invite created', content: { 'application/json': { schema: InviteResponseSchema } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'JWT required' },
  },
});

registry.registerPath({
  method: 'delete', path: '/rest-orgs/{slug}/invites/{token}',
  summary: 'Revoke an invite',
  responses: {
    204: { description: 'Revoked' },
    401: { description: 'JWT required' },
  },
});

// ── Generator ─────────────────────────────────────────────────────────────────

export interface OpenApiSpecOptions {
  serverUrl?: string;
  version?: string;
}

export function generateOpenApiSpec(options: OpenApiSpecOptions = {}): Record<string, unknown> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'LoreKit REST API',
      version: options.version ?? '1.0.0',
      description:
        'REST API for LoreKit — shared persistent memory for AI coding agents.\n\n' +
        '## Authentication\n\n' +
        'Pass `Authorization: Bearer <token>` on every request.\n' +
        '- **API tokens** (`lk_rw_*`, `lk_ro_*`, `lk_wo_*`) — for memory endpoints. ' +
        'Read-only tokens (`lk_ro_*`) are denied on write endpoints.\n' +
        '- **Supabase JWT** — required for org, member, and invite endpoints.\n',
      license: { name: 'MIT' },
      contact: { url: 'https://lorekit.io' },
    },
    servers: [
      {
        url: options.serverUrl ?? 'https://<project>.supabase.co/functions/v1',
        description: 'Supabase Edge Functions',
      },
    ],
    tags: [
      { name: 'Memories', description: 'Memory CRUD and search.' },
      { name: 'Organizations', description: 'Org management, members, invites.' },
    ],
  }) as Record<string, unknown>;
}
