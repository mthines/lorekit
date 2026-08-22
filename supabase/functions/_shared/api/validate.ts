import { z } from 'npm:zod@3';
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

/**
 * ── Why these are `<S extends z.ZodTypeAny>` and not `<T>(schema: z.ZodType<T>)`
 *
 * A zod schema has TWO types: its INPUT (what `safeParse` accepts) and its
 * OUTPUT (what it produces). `.default(x)` is precisely the case where they
 * differ — input allows the field to be absent, output guarantees a value.
 *
 * `z.ZodType<T>` declares only one, defaulting `Input = Output`, so inference
 * against a schema whose input and output disagree could bind `T` to the INPUT
 * shape. Every defaulted field then looked OPTIONAL to callers: `sort`,
 * `archived`, `limit`, `tags_mode`, `bucket` and friends came back as
 * `X | undefined` even though `safeParse` had just filled them in.
 *
 * That is not a cosmetic complaint. It made ~14 of the errors this branch
 * removes, and every one of them was the type system correctly reporting that
 * the handler's own `ListParams`/`ActivityParams` interface disagreed with what
 * the validator claimed to return. Binding `S` and projecting `z.output<S>`
 * states the real contract: what you get back is what the schema PRODUCES.
 *
 * Runtime behaviour is unchanged — `safeParse` already applied the defaults.
 */
export async function validateBody<S extends z.ZodTypeAny>(req: Request, schema: S, cors: Record<string, string> = {}): Promise<ValidationResult<z.output<S>>> {
  let raw: unknown;
  try { raw = await req.json(); }
  catch { return { ok: false, response: badRequest('Request body must be valid JSON', undefined, cors) }; }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, response: badRequest('Validation failed', fmtErrors(r.error), cors) };
  return { ok: true, data: r.data };
}

/**
 * Like validateBody, but treats a completely absent body as `{}`.
 *
 * For endpoints whose body is entirely optional (every field has a default),
 * `POST /x` with no body at all is a legitimate request — but `req.json()`
 * throws on an empty payload, so validateBody would answer 400 "Request body
 * must be valid JSON". A body that is present but malformed is still a 400.
 */
export async function validateOptionalBody<S extends z.ZodTypeAny>(req: Request, schema: S, cors: Record<string, string> = {}): Promise<ValidationResult<z.output<S>>> {
  const text = (await req.text()).trim();
  let raw: unknown = {};
  if (text) {
    try { raw = JSON.parse(text); }
    catch { return { ok: false, response: badRequest('Request body must be valid JSON', undefined, cors) }; }
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, response: badRequest('Validation failed', fmtErrors(r.error), cors) };
  return { ok: true, data: r.data };
}

export function validateQuery<S extends z.ZodTypeAny>(req: Request, schema: S, cors: Record<string, string> = {}): ValidationResult<z.output<S>> {
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

/** Validate an org slug path param (lowercase alphanumeric + hyphens, 3-50 chars). */
export function validateOrgSlug(slug: string, cors: Record<string, string> = {}): ValidationResult<string> {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || slug.length < 3 || slug.length > 50) {
    return { ok: false, response: badRequest(`Invalid org slug: "${slug}"`, undefined, cors) };
  }
  return { ok: true, data: slug };
}
