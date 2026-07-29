import { z } from 'zod';

export const MemberRoleSchema = z.enum(['owner','admin','member','viewer']);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
export const UpdateMemberRoleBodySchema = z.object({ role: MemberRoleSchema });
export const OrgMemberSchema = z.object({
  user_id: z.string().uuid(), role: MemberRoleSchema, joined_at: z.string().datetime(),
  display_name: z.string().nullable(), avatar_url: z.string().nullable(),
});
export type OrgMember = z.infer<typeof OrgMemberSchema>;
