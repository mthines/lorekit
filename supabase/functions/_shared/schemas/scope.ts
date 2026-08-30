// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/shared/scope.ts
// Regenerate: node scripts/codegen/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';

const VALID_PREFIXES = new Set(['global', 'project', 'repo', 'branch']);

/**
 * Shape-only scope schema for REST/OpenAPI use.
 * Use when semantic validation happens downstream.
 */
export const RawScopeSchema = z.string().min(1, 'scope must be a non-empty string');

/**
 * Structural scope schema — validates format and normalises to lowercase.
 * Identical contract to @lorekit/core's ScopeSchema but independent (no circular dep).
 * Use in tool schemas where the normalised value goes directly to DB queries.
 */
export const ScopeSchema = z.string().transform((val, ctx) => {
  if (!val) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scope must be a non-empty string' });
    return z.NEVER;
  }
  if (/^(project|repo|branch):[^:]/.test(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid scope "${val}": use "::" as separator, not ":"` });
    return z.NEVER;
  }
  const n = val.toLowerCase().trim();
  if (n === 'global') return 'global';
  const sep = n.indexOf('::');
  if (sep === -1) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid scope "${val}": unknown scope type` }); return z.NEVER; }
  const prefix = n.slice(0, sep);
  if (!VALID_PREFIXES.has(prefix)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid scope prefix "${prefix}"` }); return z.NEVER; }
  const suffix = n.slice(sep + 2);
  if (!suffix) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Scope suffix after "::" must not be empty` }); return z.NEVER; }
  return n;
});

export type Scope = z.output<typeof ScopeSchema>;
