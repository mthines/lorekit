// Mirror of packages/mcp-core/src/provenance/record-extensions.ts, self-contained for the Deno edge
// tree (which cannot cross-import the Node package — same pattern as origin.ts).
// Keep behaviourally identical to the mcp-core copy; the vitest suite over that
// copy is the shared guard, and `edge-parity.spec.ts` asserts this file stays in
// sync with it.
//
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
// Two more (00120) make a correction visible and safe:
//   version           every record's content version, starting at 1; read-only
//   expected_version  on a write, the version the caller last read. A stale one
//                     is refused with `version_conflict`; 0 means "must not exist"
//   superseded_by     computed on read (never stored): the ids of the records
//                     whose `supersedes` names this one
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
  expectedVersion: number | null;
}

/** The raw, unvalidated write-tool parameters. */
export interface RecordFieldsInput {
  attributes?: unknown;
  content_type?: unknown;
  supersedes?: unknown;
  expected_version?: unknown;
}

/**
 * A write refused because the record moved on since the caller read it
 * (00120). A distinct class, not a {@link RecordFieldError}: the request was
 * well-formed, and the fix is to re-read and retry, not to change the input.
 * REST answers it with 409 and MCP with an `isError` result; both carry the
 * stored version so the caller can retry without another read.
 */
export class VersionConflictError extends Error {
  readonly code = 'version_conflict';
  readonly expectedVersion: number;
  readonly currentVersion: number;
  constructor(expectedVersion: number, currentVersion: number) {
    super(
      `version_conflict: expected_version ${expectedVersion} does not match the stored version ${currentVersion}` +
        (currentVersion === 0 ? ' (the memory does not exist)' : '') +
        '. Re-read the memory, then retry with its current version.',
    );
    this.name = 'VersionConflictError';
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
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
 * Validate `expected_version`: a non-negative integer, where 0 means "the
 * record must not exist yet". Omitted is `null` — no check, today's behaviour.
 */
export function parseExpectedVersion(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > 2147483647) {
    throw new RecordFieldError(`expected_version must be a non-negative integer: ${String(input)}`);
  }
  return input;
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
    expectedVersion: parseExpectedVersion(input.expected_version),
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
  ['supersedes_not_found', 'supersedes must name a memory you can read with the same owner as this one (your own personal memory, or one in the same org)'],
  ['memories_json_value_parses', 'value must be valid JSON when content_type is application/json'],
  ['memories_content_type_known', `content_type must be one of ${CONTENT_TYPES.join(', ')}`],
  ['memories_supersedes_not_self', 'a memory cannot supersede itself'],
  ['memories_attributes_max_keys', `attributes must have <= ${ATTRIBUTES_MAX_KEYS} keys`],
];

/** `memory_write`'s LK003 message (00120): `version_conflict: expected_version=N current_version=M`. */
const VERSION_CONFLICT_RE = /version_conflict: expected_version=(\d+) current_version=(\d+)/;

/**
 * Map a database error about a record field to a {@link RecordFieldError}, and
 * `memory_write`'s version refusal to a {@link VersionConflictError}; pass
 * anything else through.
 */
export function translateRecordFieldDbError(err: unknown): unknown {
  const message = (err as { message?: string } | null | undefined)?.message ?? '';
  const conflict = VERSION_CONFLICT_RE.exec(message);
  if (conflict) return new VersionConflictError(Number(conflict[1]), Number(conflict[2]));
  for (const [marker, text] of DB_FIELD_ERRORS) {
    if (message.includes(marker)) return new RecordFieldError(text);
  }
  return err;
}

/**
 * The columns a read selects to report the record extensions. `version` rides
 * along and is always returned: unlike the three extensions it has no default
 * that says nothing (00120).
 */
export const RECORD_FIELD_COLUMNS = 'attributes,content_type,supersedes,version';

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

/** The columns a `superseded_by` lookup selects: the successor and the id it names. */
export const SUPERSEDED_BY_COLUMNS = 'id,supersedes';

/**
 * Group successor rows (`{ id, supersedes }`, newest first) by the id they
 * supersede: `superseded_by` for every record on a page, from ONE query over
 * the page's ids. Total: a row without both ids is skipped, and a successor
 * listed twice is kept once.
 */
export function groupSupersededBy(
  rows: ReadonlyArray<{ id?: unknown; supersedes?: unknown }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (typeof row?.id !== 'string' || typeof row.supersedes !== 'string') continue;
    const list = out.get(row.supersedes) ?? [];
    if (!list.includes(row.id)) list.push(row.id);
    out.set(row.supersedes, list);
  }
  return out;
}

/**
 * Attach `superseded_by` to a read result — only when something supersedes it,
 * the same "say nothing when there is nothing to say" rule
 * {@link compactRecordFields} applies, so an uncorrected record reads exactly as
 * before.
 */
export function withSupersededBy<T extends { id?: unknown }>(
  row: T,
  links: ReadonlyMap<string, string[]>,
): T & { superseded_by?: string[] } {
  const ids = typeof row.id === 'string' ? links.get(row.id) : undefined;
  return ids && ids.length > 0 ? { ...row, superseded_by: ids } : row;
}
