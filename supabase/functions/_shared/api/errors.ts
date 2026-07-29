export class RestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    // deno-lint-ignore no-explicit-any
    public readonly details?: Record<string, any>,
  ) {
    super(message);
    this.name = 'RestError';
  }

  toResponse(cors: Record<string, string> = {}): Response {
    return new Response(
      JSON.stringify({ error: this.message, ...(this.code ? { code: this.code } : {}), ...(this.details ? { details: this.details } : {}) }),
      { status: this.status, headers: { 'Content-Type': 'application/json', ...cors } },
    );
  }
}

/** Map well-known Postgres SQLSTATEs / PostgREST codes to HTTP errors. */
// deno-lint-ignore no-explicit-any
export function translateDbError(err: any): RestError | null {
  const code = err?.code ?? err?.error?.code;
  if (code === 'LK001') return new RestError('Memory limit exceeded. Archive unused memories or upgrade your plan.', 429, 'memory_cap');
  if (code === 'LK002') return new RestError('Insufficient permissions for this org action.', 403, 'org_permission_denied');
  if (code === 'PGRST116') return new RestError('Not found', 404, 'not_found');
  if (code === '23505') return new RestError('A record with this identifier already exists.', 409, 'conflict');
  return null;
}
