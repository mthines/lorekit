// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/domain/member.ts
// Regenerate: node scripts/codegen/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';

export const MemberRoleSchema = z.enum(['owner','admin','member','viewer']);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
export const UpdateMemberRoleBodySchema = z.object({ role: MemberRoleSchema });
export const OrgMemberSchema = z.object({
  user_id: z.string().uuid(), role: MemberRoleSchema, joined_at: z.string().datetime(),
  display_name: z.string().nullable(), avatar_url: z.string().nullable(),
});
export type OrgMember = z.infer<typeof OrgMemberSchema>;

/** List response for GET /orgs/:slug/members */
export const OrgMemberListResponseSchema = z.object({ entries: z.array(OrgMemberSchema) });
export type OrgMemberListResponse = z.infer<typeof OrgMemberListResponseSchema>;
