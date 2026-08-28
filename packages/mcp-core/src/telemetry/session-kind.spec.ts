import { describe, it, expect } from 'vitest';
import { SESSION_KINDS, parseSessionKind } from './session-kind.js';

describe('parseSessionKind', () => {
  it('classifies every member and rejects everything else', () => {
    for (const kind of SESSION_KINDS) expect(parseSessionKind(kind)).toBe(kind);
    expect(parseSessionKind('staging')).toBeNull();
    expect(parseSessionKind('')).toBeNull();
    expect(parseSessionKind(null)).toBeNull();
    expect(parseSessionKind(undefined)).toBeNull();
  });

  it('is bounded: an unknown value cannot smuggle a new member into the ledger', () => {
    expect(parseSessionKind('a'.repeat(500))).toBeNull();
  });

  it('is forgiving about shape, strict about membership', () => {
    expect(parseSessionKind('  CI  ')).toBe('ci');
    expect(parseSessionKind('Local')).toBe('local');
  });
});
