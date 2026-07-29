/**
 * Typed HTTP response helpers for LoreKit REST Edge Functions.
 *
 * Every handler calls one of these functions to build its response.
 * This keeps HTTP status codes, content-type headers, and CORS headers
 * consistent across all endpoints.
 *
 * Usage:
 *   return ok(data);               // 200 JSON
 *   return created(data);          // 201 JSON
 *   return noContent();            // 204 empty
 *   return badRequest('message');  // 400 JSON { error, code }
 *   return unauthorized();         // 401 JSON
 *   return forbidden('message');   // 403 JSON
 *   return notFound('message');    // 404 JSON
 *   return tooManyRequests(30);    // 429 JSON + Retry-After header
 *   return internalError('msg');   // 500 JSON
 */

import { corsHeaders } from './cors.ts';

function json(data: unknown, status: number, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
      ...(extra ?? {}),
    },
  });
}

function errorBody(message: string, code: string, fields?: Record<string, string[]>) {
  return { error: { code, message, ...(fields ? { fields } : {}) } };
}

// ── Success responses ─────────────────────────────────────────────────────────

export function ok<T>(data: T): Response {
  return json(data, 200);
}

export function created<T>(data: T): Response {
  return json(data, 201);
}

export function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

// ── Client error responses ────────────────────────────────────────────────────

export function badRequest(
  message: string,
  fields?: Record<string, string[]>,
): Response {
  return json(errorBody(message, 'bad_request', fields), 400);
}

export function unauthorized(message = 'Authentication required'): Response {
  return json(errorBody(message, 'unauthorized'), 401);
}

export function forbidden(message = 'Insufficient permissions'): Response {
  return json(errorBody(message, 'forbidden'), 403);
}

export function notFound(message = 'Resource not found'): Response {
  return json(errorBody(message, 'not_found'), 404);
}

export function methodNotAllowed(): Response {
  return json(errorBody('Method not allowed', 'method_not_allowed'), 405);
}

export function tooManyRequests(retryAfterSeconds: number, message?: string): Response {
  return json(
    errorBody(message ?? `Rate limited. Retry after ${retryAfterSeconds}s.`, 'rate_limited'),
    429,
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

// ── Server error responses ────────────────────────────────────────────────────

export function internalError(message = 'Internal server error'): Response {
  return json(errorBody(message, 'internal_error'), 500);
}

/**
 * Convert an unknown thrown value into an internal error response.
 * Logs the error to the span before returning.
 */
export function fromError(err: unknown, context?: string): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[REST] ${context ?? 'Error'}: ${message}`);
  return internalError();
}
