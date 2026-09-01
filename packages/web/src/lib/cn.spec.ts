import { describe, it, expect } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  it('joins truthy parts with a single space', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('drops false, null and undefined parts', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });

  it('supports the inline conditional idiom', () => {
    const active = true;
    const disabled = false;
    expect(cn('base', active && 'is-active', disabled && 'is-disabled')).toBe('base is-active');
  });

  it('returns an empty string when nothing is truthy', () => {
    expect(cn(false, null, undefined)).toBe('');
  });
});
