import { z } from 'zod';

export const OrgCreateSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(128),
});
export type OrgCreate = z.infer<typeof OrgCreateSchema>;

export const OrgRenameSchema = z.object({
  name: z.string().min(1).max(128),
});
export type OrgRename = z.infer<typeof OrgRenameSchema>;

export const OrgSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  created_at: z.string(),
  deleted_at: z.string().nullable().optional(),
});
export type Org = z.infer<typeof OrgSchema>;

export const MemberRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

export const MemberRoleUpdateSchema = z.object({
  role: MemberRoleSchema.exclude(['owner']),
});
export type MemberRoleUpdate = z.infer<typeof MemberRoleUpdateSchema>;

export const InviteCreateSchema = z.object({
  identity: z.string().min(1),
  role: MemberRoleSchema.exclude(['owner']),
});
export type InviteCreate = z.infer<typeof InviteCreateSchema>;
