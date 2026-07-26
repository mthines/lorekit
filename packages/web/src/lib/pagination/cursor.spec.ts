import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from './cursor';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a simple cursor', () => {
    const cur = { c: '2026-07-01T10:00:00.000Z', id: '00000000-0000-0000-0000-000000000001' };
    expect(decodeCursor(encodeCursor(cur))).toEqual(cur);
  });

  it('round-trips unicode in the id/timestamp-adjacent fields safely', () => {
    // c/id are server-generated (timestamp + uuid), but the codec itself must
    // not corrupt arbitrary unicode content if ever reused for a differently
    // shaped pure string pair.
    const cur = { c: '2026-07-01T10:00:00.000Z', id: 'unicode-emoji-id-\u{1F389}' };
    expect(decodeCursor(encodeCursor(cur))).toEqual(cur);
  });

  it('returns null for null/undefined/empty input', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('returns null for non-base64 garbage', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });

  it('returns null for valid-base64 that is not JSON', () => {
    const notJson = Buffer.from('this is not json', 'utf-8').toString('base64url');
    expect(decodeCursor(notJson)).toBeNull();
  });

  it('returns null for valid JSON missing required fields', () => {
    const missingId = Buffer.from(JSON.stringify({ c: '2026-07-01T10:00:00.000Z' }), 'utf-8').toString(
      'base64url',
    );
    expect(decodeCursor(missingId)).toBeNull();

    const missingC = Buffer.from(JSON.stringify({ id: 'abc' }), 'utf-8').toString('base64url');
    expect(decodeCursor(missingC)).toBeNull();

    const empty = Buffer.from(JSON.stringify({}), 'utf-8').toString('base64url');
    expect(decodeCursor(empty)).toBeNull();
  });

  it('returns null for wrong-typed fields', () => {
    const wrongTypes = Buffer.from(JSON.stringify({ c: 123, id: true }), 'utf-8').toString('base64url');
    expect(decodeCursor(wrongTypes)).toBeNull();
  });

  it('returns null when JSON parses to a non-object (array, string, number)', () => {
    expect(decodeCursor(Buffer.from('[1,2,3]', 'utf-8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('"just a string"', 'utf-8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('42', 'utf-8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('null', 'utf-8').toString('base64url'))).toBeNull();
  });

  it('returns null for empty-string c or id (falsy after well-typed check)', () => {
    const emptyC = Buffer.from(JSON.stringify({ c: '', id: 'abc' }), 'utf-8').toString('base64url');
    expect(decodeCursor(emptyC)).toBeNull();
    const emptyId = Buffer.from(JSON.stringify({ c: 'abc', id: '' }), 'utf-8').toString('base64url');
    expect(decodeCursor(emptyId)).toBeNull();
  });

  it('returns null for a truncated cursor (chopped mid-base64)', () => {
    const full = encodeCursor({ c: '2026-07-01T10:00:00.000Z', id: '00000000-0000-0000-0000-000000000001' });
    const truncated = full.slice(0, Math.floor(full.length / 2));
    expect(decodeCursor(truncated)).toBeNull();
  });

  it('never throws on hostile input', () => {
    const hostileInputs = [
      'a'.repeat(10_000),
      'whitespace-only-placeholder',
      '=====',
      '{"c":"x","id":"y"}', // raw JSON, not base64-wrapped — decodes as base64 garbage
    ];
    for (const input of hostileInputs) {
      expect(() => decodeCursor(input)).not.toThrow();
    }
  });
});
