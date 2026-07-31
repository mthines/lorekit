// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/invite.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';
import { MemberRoleSchema } from './member.ts';

export const CreateInviteBodySchema = z.object({
  email: z.string().email().optional(),
  handle: z.string().min(1).optional(),
  role: MemberRoleSchema.exclude(['owner']).default('member'),
}).refine((d) => d.email !== undefined || d.handle !== undefined, { message: 'Either email or handle is required' });
export type CreateInviteBody = z.infer<typeof CreateInviteBodySchema>;
export const OrgInviteSchema = z.object({
  id: z.string().uuid(), org_id: z.string().uuid(),
  email: z.string().nullable(), handle: z.string().nullable(),
  role: MemberRoleSchema, created_at: z.string().datetime(), expires_at: z.string().datetime().nullable(),
});
export type OrgInvite = z.infer<typeof OrgInviteSchema>;

/** List response for GET /orgs/:slug/invites */
export const OrgInviteListResponseSchema = z.object({ entries: z.array(OrgInviteSchema) });
export type OrgInviteListResponse = z.infer<typeof OrgInviteListResponseSchema>;
