// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/common.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';

export const CursorSchema = z.string().min(1);
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: CursorSchema.optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const FilterOperatorSchema = z.enum(['is','is_not','contains','does_not_contain','starts_with','ends_with','is_set','is_not_set']);
export const FilterConditionSchema = z.object({
  field: z.string().min(1),
  op: FilterOperatorSchema,
  value: z.string().optional(),
});
export type FilterCondition = z.infer<typeof FilterConditionSchema>;

export type FilterGroup = { and: FilterGroup[] } | { or: FilterGroup[] } | FilterCondition;
export const FilterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(FilterGroupSchema) }),
    z.object({ or: z.array(FilterGroupSchema) }),
    FilterConditionSchema,
  ])
);

export const ErrorResponseSchema = z.object({ error: z.string(), code: z.string().optional(), details: z.record(z.unknown()).optional() });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const UuidSchema = z.string().uuid('must be a valid UUID');

// Path parameter schemas — used by REST route handlers and OpenAPI spec.
export const MemoryIdParamsSchema = z.object({ id: UuidSchema });
export type MemoryIdParams = z.infer<typeof MemoryIdParamsSchema>;

export const OrgSlugParamsSchema = z.object({ slug: z.string().min(3).max(50) });
export type OrgSlugParams = z.infer<typeof OrgSlugParamsSchema>;

export const OrgSlugMemberParamsSchema = z.object({ slug: z.string().min(3).max(50), userId: UuidSchema });
export type OrgSlugMemberParams = z.infer<typeof OrgSlugMemberParamsSchema>;

export const OrgSlugInviteParamsSchema = z.object({ slug: z.string().min(3).max(50), inviteId: UuidSchema });
export type OrgSlugInviteParams = z.infer<typeof OrgSlugInviteParamsSchema>;
