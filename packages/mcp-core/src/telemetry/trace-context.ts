/**
 * Pure W3C Trace Context (`traceparent`) parsing and formatting.
 *
 * The header format is:
 *
 *   `<version>-<trace-id>-<parent-id>-<trace-flags>`
 *   e.g. `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 *
 * `parseTraceparent` is a total function: it returns `null` for ANYTHING that
 * is not a spec-valid header, so a malformed inbound header degrades to a new
 * root trace instead of producing a corrupt (unlinkable) exported span.
 * Validation follows https://www.w3.org/TR/trace-context/ exactly:
 *   - every field is lowercase hex (uppercase is invalid per spec)
 *   - an all-zero trace-id or parent-id is invalid
 *   - version `ff` is forbidden
 *   - version `00` is a fixed 4-field format; a future version may append
 *     extra fields, which we accept and ignore
 *
 * The `sampled` flag is parsed and carried so callers can *propagate* it.
 * LoreKit deliberately does not act on it (AlwaysOn export — sampling is
 * deferred to the Dash0 pipeline).
 *
 * This module is import-free so it can be mirrored verbatim into the Deno
 * edge function (`supabase/functions/_shared/trace-context.ts`) and kept in
 * sync by `edge-parity.spec.ts` in `packages/mcp-core`.
 */

/** The only `traceparent` version LoreKit emits. */
export const TRACEPARENT_VERSION = '00';

export interface ParsedTraceparent {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

const HEX_2 = /^[0-9a-f]{2}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const ALL_ZERO = /^0+$/;

/** A trace-id is 32 lowercase hex chars and must not be all zeroes. */
export function isValidTraceId(value: string): boolean {
  return HEX_32.test(value) && !ALL_ZERO.test(value);
}

/** A span-id is 16 lowercase hex chars and must not be all zeroes. */
export function isValidSpanId(value: string): boolean {
  return HEX_16.test(value) && !ALL_ZERO.test(value);
}

/**
 * Parse a `traceparent` header value. Returns null when the header is absent,
 * empty, or invalid in any way — the caller should then start a new root trace.
 */
export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (!header) return null;

  const parts = header.split('-');
  // At least the four version-00 fields. Future versions MAY append more.
  if (parts.length < 4) return null;

  const version = parts[0];
  const traceId = parts[1];
  const parentSpanId = parts[2];
  const flags = parts[3];

  if (!HEX_2.test(version)) return null;
  // `ff` is explicitly forbidden by the spec (reserved as an invalid value).
  if (version === 'ff') return null;
  // The `00` format is fixed-length; trailing fields are only legal for a
  // future version that defines them.
  if (version === TRACEPARENT_VERSION && parts.length !== 4) return null;

  if (!isValidTraceId(traceId)) return null;
  if (!isValidSpanId(parentSpanId)) return null;
  if (!HEX_2.test(flags)) return null;

  return {
    traceId,
    parentSpanId,
    // Only bit 0 (`sampled`) is defined; every other bit is ignored.
    sampled: (parseInt(flags, 16) & 0x01) === 1,
  };
}

/** Build a version-`00` `traceparent` header value. */
export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}
