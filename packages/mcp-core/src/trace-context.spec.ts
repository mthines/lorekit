import { describe, it, expect } from 'vitest';
import {
  TRACEPARENT_VERSION,
  formatTraceparent,
  isValidSpanId,
  isValidTraceId,
  parseTraceparent,
} from './trace-context.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

describe('parseTraceparent', () => {
  it('parses a valid sampled header', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
      sampled: true,
    });
  });

  it('parses a valid unsampled header', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
      sampled: false,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('returns null for %s', (_label, input) => {
    expect(parseTraceparent(input)).toBeNull();
  });

  it('rejects a header with too few fields', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}`)).toBeNull();
    expect(parseTraceparent('00')).toBeNull();
  });

  it('rejects the forbidden ff version', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects a non-hex / wrong-length version', () => {
    expect(parseTraceparent(`zz-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`0-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`000-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects version 00 with a fifth field (the 00 format is fixed-length)', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeNull();
  });

  it('accepts a future version with extra fields and uses the first four', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra`)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
      sampled: true,
    });
  });

  it('rejects a correct-length but non-hex trace-id (the corrupt-span bug)', () => {
    // 32 chars, so a length-only check would have accepted it and exported a
    // span with an unusable trace id instead of starting a new root trace.
    expect(parseTraceparent(`00-${'z'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects a correct-length but non-hex parent-id', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${'z'.repeat(16)}-01`)).toBeNull();
  });

  it('rejects uppercase hex', () => {
    expect(parseTraceparent(`00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID.toUpperCase()}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-0A`)).toBeNull();
  });

  it('rejects an all-zero trace-id', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects an all-zero parent-id', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it('rejects a wrong-length trace-id', () => {
    expect(parseTraceparent(`00-${TRACE_ID.slice(0, 31)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}a-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects a wrong-length parent-id', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID.slice(0, 15)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}a-01`)).toBeNull();
  });

  it('rejects malformed trace-flags', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-1`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-001`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-zz`)).toBeNull();
  });

  it('reads only bit 0 of trace-flags: 02 is not sampled', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-02`)?.sampled).toBe(false);
  });

  it('reads only bit 0 of trace-flags: 03 is sampled', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-03`)?.sampled).toBe(true);
  });
});

describe('formatTraceparent', () => {
  it('emits the version-00 sampled form', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, true)).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it('emits the version-00 unsampled form', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, false)).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
  });

  it.each([true, false])('round-trips through parseTraceparent (sampled=%s)', (sampled) => {
    expect(parseTraceparent(formatTraceparent(TRACE_ID, SPAN_ID, sampled))).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
      sampled,
    });
  });

  it('uses the exported version constant', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID, true).startsWith(`${TRACEPARENT_VERSION}-`)).toBe(true);
  });
});

describe('id validators', () => {
  it('validates trace ids', () => {
    expect(isValidTraceId(TRACE_ID)).toBe(true);
    expect(isValidTraceId('0'.repeat(32))).toBe(false);
    expect(isValidTraceId(TRACE_ID.toUpperCase())).toBe(false);
    expect(isValidTraceId(SPAN_ID)).toBe(false);
  });

  it('validates span ids', () => {
    expect(isValidSpanId(SPAN_ID)).toBe(true);
    expect(isValidSpanId('0'.repeat(16))).toBe(false);
    expect(isValidSpanId(SPAN_ID.toUpperCase())).toBe(false);
    expect(isValidSpanId(TRACE_ID)).toBe(false);
  });
});
