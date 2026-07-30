import { z } from 'zod';

export const OrgSlugSchema = z.string().min(3).max(50)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'slug must be lowercase alphanumeric with hyphens');
export const CreateOrgBodySchema = z.object({ slug: OrgSlugSchema, name: z.string().min(1).max(100) });
export type CreateOrgBody = z.infer<typeof CreateOrgBodySchema>;
export const RenameOrgBodySchema = z.object({ name: z.string().min(1).max(100) });
export type RenameOrgBody = z.infer<typeof RenameOrgBodySchema>;
export const OrgResponseSchema = z.object({ id: z.string().uuid(), slug: z.string(), name: z.string(), created_at: z.string().datetime() });
export type OrgResponse = z.infer<typeof OrgResponseSchema>;

/** Paginated list response for GET /orgs */
export const OrgListResponseSchema = z.object({ entries: z.array(OrgResponseSchema) });
export type OrgListResponse = z.infer<typeof OrgListResponseSchema>;
