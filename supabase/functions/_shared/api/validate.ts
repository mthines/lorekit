/**
 * Request validation helpers for LoreKit REST Edge Functions.
 *
 * Uses Zod for schema validation. Returns a typed result that forces
 * callers to handle both the success and error cases.
 *
 * Usage (request body):
 *   const result = await validateBody(req, WriteInputSchema);
 *   if (!result.ok) return result.error; // Response with 400
 *   const data = result.data;            // Typed validated data
 *
 * Usage (query params):
 *   const result = validateQuery(req, MemoryListParamsSchema);
 *   if (!result.ok) return result.error;
 *   const params = result.data;
 *
 * Usage (path param UUID):
 *   const result = validateUuid(rawId, 'id');
 *   if (!result.ok) return result.error;
 *   const id = result.data;
 */

import { z } from 'npm:zod@3';
import { badRequest } from './respond.ts';

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: Response };

function formatZodError(err: z.ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.') || '_root';
    if (!fields[path]) fields[path] = [];
    fields[path].push(issue.message);
  }
  return fields;
}

/**
 * Parse and validate a JSON request body against a Zod schema.
 * Returns 400 with field-level errors on failure.
 */
export async function validateBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<ValidationResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      error: badRequest('Request body must be valid JSON'),
    };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: badRequest('Validation failed', formatZodError(result.error)),
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Parse and validate URL query parameters against a Zod schema.
 * Converts URLSearchParams to a plain object before parsing.
 * Returns 400 with field-level errors on failure.
 */
export function validateQuery<T>(
  req: Request,
  schema: z.ZodType<T>,
): ValidationResult<T> {
  const url = new URL(req.url);
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = raw[key];
    if (existing === undefined) {
      raw[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      raw[key] = [existing, value];
    }
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: badRequest('Invalid query parameters', formatZodError(result.error)),
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate a path parameter as a UUID.
 * Returns 400 if invalid.
 */
export function validateUuid(
  value: string | undefined,
  paramName = 'id',
): ValidationResult<string> {
  const UuidSchema = z.string().uuid();
  const result = UuidSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      error: badRequest(`Invalid ${paramName}: must be a valid UUID`),
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Extract a path segment from the URL using a simple pattern match.
 * For example: extractPathParam(req, '/rest-memories/', 0) → first segment after prefix.
 *
 * @param req - The incoming request
 * @param prefix - The URL prefix to strip (e.g. '/rest-memories')
 * @param segments - The path segments after the prefix, split by '/'
 */
export function extractPathSegments(req: Request, prefix: string): string[] {
  const url = new URL(req.url);
  const path = url.pathname;
  const after = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return after.split('/').filter(Boolean);
}
