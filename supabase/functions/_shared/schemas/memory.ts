/**
 * Memory schemas — single source of truth for all lorekit memory data shapes.
 * Used by @lorekit/core (Node), Supabase Edge Functions (Deno), and the CLI.
 */
import { z } from 'zod';
import { ScopeSchema } from './scope.js';

export const MAX_VALUE_BYTES = 65_536;
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

// ── MCP tool input schemas (shared with @lorekit/core) ───────────────────────

export const WriteInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
  value: z.string().max(MAX_VALUE_BYTES, `value exceeds ${MAX_VALUE_BYTES} bytes`),
  tags: z.array(z.string()).optional().default([]),
  source_agent: z.string().optional(),
  trigger: z.string().optional(),
  // Optional creation-date override for migrating pre-existing memories. When
  // omitted the DB applies its now() default. Validated (and future-dates
  // rejected) by parseCreatedAt below, not by zod, so the error message and the
  // clock-skew rule stay shared with the edge mirror.
  created_at: z.string().optional(),
  // Org slug to write under (org-owned write). Omit for a personal memory.
  // Ownership is authorization-derived inside memory_write — supplying an
  // org here does not by itself grant write access to it.
  org: z.string().optional(),
  // Optional TTL in days. When set, expires_at is computed as
  // now() + ttl_days * 1 day. On an UPDATE the TTL is refreshed only when
  // ttl_days is supplied; omitting it on an update leaves the existing expiry
  // unchanged. Validated by parseTtlDays (1–365).
  ttl_days: z.number().int().min(1).max(365).optional(),
  // When true, clears an existing expires_at (makes the memory permanent again).
  // Ignored when ttl_days is also supplied — clear takes precedence inside the RPC.
  clear_ttl: z.boolean().optional().default(false),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;

export const ListInputSchema = z.object({
  scope: ScopeSchema,
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
});

export type ListInput = z.infer<typeof ListInputSchema>;

export const ReadInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;

export const SearchInputSchema = z.object({
  q: z.string().min(1).max(512),
  scopes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;

export const DeleteInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
  /**
   * When true, permanently hard-delete the row instead of soft-archiving it.
   * Defaults to false (soft-archive). Use with caution — hard-deleted rows
   * cannot be restored.
   */
  force: z.boolean().optional().default(false),
  // Org slug to delete under (org-owned delete). Omit for a personal memory.
  // Routed through the role-gated memory_delete RPC — never the raw
  // service-role .delete()/.update() below, which would bypass the role gate.
  org: z.string().optional(),
});

export type DeleteInput = z.infer<typeof DeleteInputSchema>;

export const ArchiveInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
});

export type ArchiveInput = z.infer<typeof ArchiveInputSchema>;

export const RestoreInputSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
});

export type RestoreInput = z.infer<typeof RestoreInputSchema>;

export const ListArchivedInputSchema = z.object({
  scope: ScopeSchema,
  limit: z.number().int().min(1).max(100).optional().default(50),
});

export type ListArchivedInput = z.infer<typeof ListArchivedInputSchema>;

export const PurgeInputSchema = z.object({
  /**
   * Number of days after archiving before a memory is eligible for permanent deletion.
   * Defaults to 30. Minimum 1, maximum 365.
   */
  retention_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .default(PURGE_RETENTION_DAYS_DEFAULT),
});

export type PurgeInput = z.infer<typeof PurgeInputSchema>;

// ── REST API schemas (new) ────────────────────────────────────────────────────

export const MemoryUpdateSchema = z.object({
  value: z.string().max(MAX_VALUE_BYTES).optional(),
  tags: z.array(z.string()).optional(),
  source_agent: z.string().optional(),
  trigger: z.string().optional(),
  ttl_days: z.number().int().min(1).max(365).optional(),
  clear_ttl: z.boolean().optional(),
  org: z.string().optional(),
});

export type MemoryUpdate = z.infer<typeof MemoryUpdateSchema>;

/**
 * Query parameters for GET /rest-memories (list with pagination + simple filters).
 * Complex OR+AND filtering is handled via POST /rest-memories/search.
 */
export const MemoryListParamsSchema = z.object({
  /** Filter by exact scope. */
  scope: z.string().optional(),
  /**
   * Filter by exact key (natural key lookup when combined with scope).
   * Returns at most one item when both scope and key are present.
   */
  key: z.string().min(1).max(512).optional(),
  /** Filter by tags (any tag match). Comma-separated or repeated param. */
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  /** Filter org-owned memories by org slug. */
  org: z.string().optional(),
  /** Maximum items to return (1–100, default 50). */
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  /** Opaque cursor from a previous page response. */
  cursor: z.string().optional(),
});
export type MemoryListParams = z.infer<typeof MemoryListParamsSchema>;

/**
 * Request body for POST /rest-memories/search.
 * Supports full-text search and an OR+AND filter tree, with pagination.
 */
export const MemorySearchBodySchema = z.object({
  /** Full-text search query (optional — omit to filter without FTS). */
  q: z.string().min(1).max(512).optional(),
  /** Scope filters — list of scope strings to restrict the search to. */
  scopes: z.array(z.string()).optional(),
  /** Tag filters (any match). */
  tags: z.array(z.string()).optional(),
  /** Maximum items to return (1–100, default 20). */
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  /** Opaque cursor from a previous page response. */
  cursor: z.string().optional(),
});
export type MemorySearchBody = z.infer<typeof MemorySearchBodySchema>;

/**
 * A single memory row as returned by the REST API.
 */
export const MemoryResponseSchema = z.object({
  id: z.string().uuid(),
  scope: z.string(),
  key: z.string(),
  value: z.string(),
  tags: z.array(z.string()),
  source_agent: z.string().nullable(),
  trigger: z.string().nullable(),
  org_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable(),
  archived_at: z.string().nullable(),
});
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;

/** Response for write/create operations. */
export const MemoryWriteResponseSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string(),
  expires_at: z.string().nullable().optional(),
});
export type MemoryWriteResponse = z.infer<typeof MemoryWriteResponseSchema>;
