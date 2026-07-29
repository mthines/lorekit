import { z } from 'zod';

// Cursor-based pagination
export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

// OR+AND filter node
export type FilterNode = FilterLeaf | FilterAnd | FilterOr;

export const FilterLeafSchema = z.object({
  field: z.string(),
  op: z.enum(['is', 'contains', 'starts_with', 'ends_with', 'is_one_of']),
  value: z.union([z.string(), z.array(z.string())]),
});
export type FilterLeaf = z.infer<typeof FilterLeafSchema>;

export const FilterAndSchema: z.ZodType<{ and: FilterNode[] }> = z.lazy(() =>
  z.object({ and: z.array(FilterNodeSchema) }),
);

export const FilterOrSchema: z.ZodType<{ or: FilterNode[] }> = z.lazy(() =>
  z.object({ or: z.array(FilterNodeSchema) }),
);

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([FilterLeafSchema, FilterAndSchema, FilterOrSchema]),
);

// Standard API error response shape
export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// Paginated list response wrapper
export function paginatedResponse<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    entries: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
}
