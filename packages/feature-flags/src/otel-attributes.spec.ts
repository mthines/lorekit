import { describe, expect, it } from 'vitest';
import { flagReasonValue } from './otel-attributes.ts';

describe('flagReasonValue', () => {
  it("lowercases OpenFeature's reasons to the semantic conventions' values", () => {
    expect(flagReasonValue('STATIC')).toBe('static');
    expect(flagReasonValue('SPLIT')).toBe('split');
    expect(flagReasonValue('OVERRIDE')).toBe('override');
  });

  it('reports a missing reason as unknown, never an empty string', () => {
    // An empty attribute value is indistinguishable from "not set" in a query.
    expect(flagReasonValue(undefined)).toBe('unknown');
    expect(flagReasonValue('')).toBe('unknown');
  });
});
