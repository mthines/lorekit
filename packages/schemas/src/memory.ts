import { z } from 'zod';
import { ScopeSchema, RawScopeSchema } from './scope.ts';
import { FilterGroupSchema } from './common.ts';

export const MAX_VALUE_BYTES = 65_536;
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

export const MemoryWriteSchema = z.object({
  scope: ScopeSchema, key: z.string().min(1).max(512),
  value: z.string().max(MAX_VALUE_BYTES, `value exceeds ${MAX_VALUE_BYTES} bytes`),
  tags: z.array(z.string()).optional().default([]),
  source_agent: z.string().optional(), trigger: z.string().optional(),
  created_at: z.string().optional(), org: z.string().optional(),
  ttl_days: z.number().int().min(1).max(365).optional(),
  clear_ttl: z.boolean().optional().default(false),
});
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;

export const MemoryReadSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512) });
export const MemoryListSchema = z.object({ scope: ScopeSchema, tags: z.array(z.string()).optional(), limit: z.number().int().min(1).max(100).optional().default(50) });
export const MemoryDeleteSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512), force: z.boolean().optional().default(false) });
export const MemorySearchSchema = z.object({ q: z.string().min(1), scopes: z.array(RawScopeSchema).optional(), tags: z.array(z.string()).optional() });
export const MemoryArchiveSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512) });
export const MemoryRestoreSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512) });
export const MemoryListArchivedSchema = z.object({ scope: ScopeSchema, limit: z.number().int().min(1).max(100).optional().default(50) });
export const MemoryPurgeSchema = z.object({ retention_days: z.number().int().min(1).max(365).optional().default(PURGE_RETENTION_DAYS_DEFAULT) });

// REST-specific
export const ListMemoriesQuerySchema = z.object({
  scope: RawScopeSchema.optional(),
  key: z.string().min(1).max(512).optional(),
  tags: z.string().optional(),
  archived: z.enum(['true','false']).optional().default('false'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
});
export type ListMemoriesQuery = z.infer<typeof ListMemoriesQuerySchema>;

export const CreateMemoryBodySchema = MemoryWriteSchema.extend({ scope: RawScopeSchema });
export type CreateMemoryBody = z.infer<typeof CreateMemoryBodySchema>;

export const UpdateMemoryBodySchema = MemoryWriteSchema
  .omit({ scope: true, key: true, created_at: true }).partial()
  .refine((d) => Object.keys(d).some((k) => d[k as keyof typeof d] !== undefined), { message: 'PATCH body must contain at least one field' });
export type UpdateMemoryBody = z.infer<typeof UpdateMemoryBodySchema>;

export const SearchMemoriesBodySchema = z.object({
  q: z.string().optional(), scopes: z.array(RawScopeSchema).optional(),
  tags: z.array(z.string()).optional(), filter: FilterGroupSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
}).refine((d) => d.q !== undefined || d.scopes !== undefined || d.filter !== undefined, { message: 'At least one of q, scopes, or filter is required' });
export type SearchMemoriesBody = z.infer<typeof SearchMemoriesBodySchema>;

export const MemoryEntrySchema = z.object({
  id: z.string().uuid(), scope: z.string(), key: z.string(), value: z.string(),
  tags: z.array(z.string()), source_agent: z.string().nullable(), trigger: z.string().nullable(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(), archived_at: z.string().datetime().nullable(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
