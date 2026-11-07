// Optional record-extension parameters for memory.write: `attributes`,
// `content_type` and `supersedes`, plus the bare-id form of a `cited` entry.
//
// The four fields close the additive gaps described in the blog post "Seven
// gaps in LoreKit's memory format":
//   attributes    an open map of namespaced keys (`ci.run_url`, `vcs.pr`) to
//                 scalar values, for metadata no fixed column anticipates
//   content_type  what the value is: `text/markdown` (the default) or
//                 `application/json`
//   supersedes    the id of the record this one replaces
//   cited (ids)   a citation that names a record by its stable id instead of
//                 by its `scope::key` address, which can change
//
// `parseRecordFields` is the single, pure validation gate for all of them. It
// is mirrored self-contained into the Deno edge tree
// (supabase/functions/_shared/provenance/record-extensions.ts) because BOTH the
// MCP tools and the REST `POST /memories` handler validate through it — the
// same pattern as origin.ts. Keep the two copies behaviourally identical;
// `edge-parity.spec.ts` asserts they stay in sync.
//
// Like origin.ts, a malformed value is REJECTED rather than dropped, and an
// omitted value is `null`, which the RPC reads as "keep what is stored".

export class RecordFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordFieldError';
  }
}

/** The content types a record may declare. The first is the default. */
export const CONTENT_TYPES = ['text/markdown', 'application/json'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * A lowercase, dot-separated attribute key: `ci.run_url`, `vcs.pr`, `team`.
 * The same shape OpenTelemetry uses for attribute names, so a key copied from
 * a span reads the same here.
 */
const ATTRIBUTE_KEY_RE = /^[a-z0-9_]+(?:[.-][a-z0-9_]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const ATTRIBUTES_MAX_KEYS = 32;
export const ATTRIBUTE_KEY_MAX = 128;
export const ATTRIBUTE_VALUE_MAX = 1024;

/** A stored attribute value. `null` in a WRITE removes the key. */
export type AttributeValue = string | number | boolean;
export type AttributesInput = Record<string, AttributeValue | null>;

/** A validated, normalised set of record extensions. */
export interface RecordFields {
  attributes: AttributesInput | null;
  contentType: ContentType | null;
  supersedes: string | null;
}

/** The raw, unvalidated write-tool parameters. */
export interface RecordFieldsInput {
  attributes?: unknown;
  content_type?: unknown;
  supersedes?: unknown;
}

/** True when `input` is a record id (a lowercase or uppercase uuid). */
export function isMemoryId(input: unknown): input is string {
  return typeof input === 'string' && UUID_RE.test(input.trim().toLowerCase());
}

/**
 * Validate `attributes`: a flat object whose keys are namespaced identifiers
 * and whose values are scalars. A `null` value is kept, because on an update it
 * means "remove this key"; the RPC merges the map into what is stored.
 */
export function parseAttributes(input: unknown): AttributesInput | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new RecordFieldError('attributes must be an object of key/value pairs');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > ATTRIBUTES_MAX_KEYS) {
    throw new RecordFieldError(`attributes must have <= ${ATTRIBUTES_MAX_KEYS} keys`);
  }
  const out: AttributesInput = {};
  for (const [key, value] of entries) {
    if (key.length > ATTRIBUTE_KEY_MAX || !ATTRIBUTE_KEY_RE.test(key)) {
      throw new RecordFieldError(
        `attribute key must be lowercase and dot-separated (e.g. "ci.run_url"), <= ${ATTRIBUTE_KEY_MAX} characters: ${key}`,
      );
    }
    if (value === null || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RecordFieldError(`attribute ${key} must be a finite number`);
      out[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > ATTRIBUTE_VALUE_MAX) {
        throw new RecordFieldError(`attribute ${key} must be <= ${ATTRIBUTE_VALUE_MAX} characters`);
      }
      out[key] = value;
    } else {
      throw new RecordFieldError(`attribute ${key} must be a string, number, boolean, or null`);
    }
  }
  return out;
}

/** Validate `content_type` against {@link CONTENT_TYPES}. */
export function parseContentType(input: unknown): ContentType | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') throw new RecordFieldError('content_type must be a string');
  const lowered = input.trim().toLowerCase();
  if (!(CONTENT_TYPES as readonly string[]).includes(lowered)) {
    throw new RecordFieldError(`content_type must be one of ${CONTENT_TYPES.join(', ')}: ${input}`);
  }
  return lowered as ContentType;
}

/** Validate `supersedes` as a record id, normalised to lowercase. */
export function parseSupersedes(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (!isMemoryId(input)) throw new RecordFieldError(`supersedes must be a memory id (uuid): ${String(input)}`);
  return (input as string).trim().toLowerCase();
}

/**
 * Validate and normalise the record-extension write parameters.
 *
 * `value` is the record body: when the write declares `application/json`, the
 * body must parse, so a consumer that trusts the declared type never meets a
 * body it cannot read.
 *
 * @returns every unsupplied field as `null` (the RPC then keeps what is stored).
 * @throws {RecordFieldError} when a supplied value is malformed.
 */
export function parseRecordFields(input: RecordFieldsInput, value: string): RecordFields {
  const contentType = parseContentType(input.content_type);
  if (contentType === 'application/json') {
    try {
      JSON.parse(value);
    } catch {
      throw new RecordFieldError('value must be valid JSON when content_type is application/json');
    }
  }
  return {
    attributes: parseAttributes(input.attributes),
    contentType,
    supersedes: parseSupersedes(input.supersedes),
  };
}

/**
 * Split a raw `cited` array into the entries that are record ids and the rest.
 * The rest are `scope::key` references, still parsed (and silently filtered) by
 * the scope module's `parseMemoryRefs`, so this adds the id form without a
 * second reference parser.
 */
export function splitCitedIds(cited: unknown): { ids: string[]; refs: unknown[] } {
  if (!Array.isArray(cited)) return { ids: [], refs: [] };
  const ids = new Set<string>();
  const refs: unknown[] = [];
  for (const entry of cited) {
    if (isMemoryId(entry)) ids.add(entry.trim().toLowerCase());
    else refs.push(entry);
  }
  return { ids: [...ids], refs };
}

/**
 * The database's own rejections of these fields, as user errors. The RPC and
 * the table constraints are the last gate (a JSON record updated without a
 * content_type still has its body checked, and only the database can see
 * whether a `supersedes` id is readable), so their errors must reach the
 * caller as the same {@link RecordFieldError} the parser throws.
 */
const DB_FIELD_ERRORS: ReadonlyArray<readonly [string, string]> = [
  ['supersedes_not_found', 'supersedes names a memory that does not exist or that you cannot read'],
  ['memories_json_value_parses', 'value must be valid JSON when content_type is application/json'],
  ['memories_content_type_known', `content_type must be one of ${CONTENT_TYPES.join(', ')}`],
  ['memories_supersedes_not_self', 'a memory cannot supersede itself'],
  ['memories_attributes_max_keys', `attributes must have <= ${ATTRIBUTES_MAX_KEYS} keys`],
];

/** Map a database error about a record field to a {@link RecordFieldError}; pass anything else through. */
export function translateRecordFieldDbError(err: unknown): unknown {
  const message = (err as { message?: string } | null | undefined)?.message ?? '';
  for (const [marker, text] of DB_FIELD_ERRORS) {
    if (message.includes(marker)) return new RecordFieldError(text);
  }
  return err;
}

/** The columns a read selects to report the record extensions. */
export const RECORD_FIELD_COLUMNS = 'attributes,content_type,supersedes';

type WithRecordFields = { attributes?: unknown; content_type?: unknown; supersedes?: unknown };

/**
 * Shape a read result for an agent: keep the record extensions only where they
 * say something. An empty map, the default content type, and a missing link
 * are left out, so a lesson that uses none of them reads exactly as before and
 * costs no extra tokens on every read.
 */
export function compactRecordFields<T extends WithRecordFields>(
  row: T,
): Omit<T, keyof WithRecordFields> & Partial<WithRecordFields> {
  const { attributes, content_type, supersedes, ...rest } = row;
  const hasAttributes = typeof attributes === 'object' && attributes !== null && Object.keys(attributes).length > 0;
  return {
    ...rest,
    ...(hasAttributes ? { attributes } : {}),
    ...(typeof content_type === 'string' && content_type !== CONTENT_TYPES[0] ? { content_type } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
}
