import { z } from 'zod';
import { badRequest } from './respond.ts';

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; response: Response };
export type ValidationResult<T> = Ok<T> | Err;

function fmtErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const p = issue.path.join('.') || '_root';
    (out[p] ??= []).push(issue.message);
  }
  return out;
}

export async function validateBody<T>(req: Request, schema: z.ZodType<T>, cors: Record<string, string> = {}): Promise<ValidationResult<T>> {
  let raw: unknown;
  try { raw = await req.json(); }
  catch { return { ok: false, response: badRequest('Request body must be valid JSON', undefined, cors) }; }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, response: badRequest('Validation failed', fmtErrors(r.error), cors) };
  return { ok: true, data: r.data };
}

export function validateQuery<T>(req: Request, schema: z.ZodType<T>, cors: Record<string, string> = {}): ValidationResult<T> {
  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, response: badRequest('Invalid query parameters', fmtErrors(r.error), cors) };
  return { ok: true, data: r.data };
}

export function validateUuid(id: string, cors: Record<string, string> = {}): ValidationResult<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, response: badRequest(`Invalid ID: "${id}"`, undefined, cors) };
  }
  return { ok: true, data: id };
}
