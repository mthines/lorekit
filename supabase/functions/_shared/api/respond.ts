const JSON_CT = { 'Content-Type': 'application/json' };

function h(cors: Record<string, string>): Record<string, string> {
  return { ...JSON_CT, ...cors };
}

export function ok(data: unknown, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: h(cors) });
}
export function created(data: unknown, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status: 201, headers: h(cors) });
}
export function noContent(cors: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers: cors });
}
export function badRequest(message: string, details?: Record<string, unknown>, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message, ...(details ? { details } : {}) }), { status: 400, headers: h(cors) });
}
export function unauthorized(cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: 'Authentication required', code: 'unauthorized' }), { status: 401, headers: h(cors) });
}
export function forbidden(message = 'Insufficient permissions', cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message, code: 'forbidden' }), { status: 403, headers: h(cors) });
}
export function notFound(resource = 'Resource', cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: `${resource} not found`, code: 'not_found' }), { status: 404, headers: h(cors) });
}
export function tooManyRequests(retryAfterSeconds: number, cors: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ error: 'Too many requests', code: 'rate_limited', retryAfterSeconds }),
    { status: 429, headers: { ...h(cors), 'Retry-After': String(retryAfterSeconds) } },
  );
}
export function methodNotAllowed(cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: 'Method not allowed', code: 'method_not_allowed' }), { status: 405, headers: h(cors) });
}
export function internalError(cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: 'Internal server error', code: 'internal_error' }), { status: 500, headers: h(cors) });
}
/**
 * Short-circuit response for a dry-run request: the handler validated and
 * authorized the call but made no changes. Signals via a 200 body flag and the
 * `X-LoreKit-Dry-Run: applied` header. See `_shared/dry-run.ts`.
 */
export function dryRun(cors: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      dry_run: true,
      message: 'Validated and authorized; no changes were made. Set X-LoreKit-Dry-Run: false to execute.',
    }),
    { status: 200, headers: { ...h(cors), 'X-LoreKit-Dry-Run': 'applied' } },
  );
}
