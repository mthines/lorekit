// Mirror of packages/mcp-core/src/telemetry/trace-context.ts, self-contained for the
// Deno edge function (which cannot cross-import the Node package — same
// pattern as auth-token.ts / created-at.ts / org-permissions.ts). Keep
// behaviourally identical to the mcp-core copy; the vitest suite over that
// copy (trace-context.spec.ts) is the shared guard, and edge-parity.spec.ts
// fails if the two ever drift.

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
 * Validation follows https://www.w3.org/TR/trace-context/ : lowercase hex only,
 * no all-zero trace-id/parent-id, version `ff` forbidden, version `00` fixed at
 * four fields (a future version may append fields, which are ignored).
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
