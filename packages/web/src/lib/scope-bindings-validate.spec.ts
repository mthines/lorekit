/**
 * Contract tests for `validateScopeBindingPattern` — the shared gate
 * `bindScope` and `BindScopeForm` both consume. Pins that a valid wildcard and
 * a valid exact scope are accepted, and that a malformed wildcard AND a
 * non-canonical exact string are both rejected (AC-7).
 */

import { describe, it, expect } from 'vitest';
import { validateScopeBindingPattern } from './scope-bindings-validate';

describe('validateScopeBindingPattern', () => {
  it('accepts a valid owner wildcard', () => {
    const result = validateScopeBindingPattern('repo::dash0hq/*');
    expect(result).toEqual({ ok: true, normalized: 'repo::dash0hq/*' });
  });

  it('accepts a valid branch-scoped wildcard', () => {
    const result = validateScopeBindingPattern('branch::dash0hq/dash0::*');
    expect(result).toEqual({ ok: true, normalized: 'branch::dash0hq/dash0::*' });
  });

  it('accepts a valid exact scope', () => {
    const result = validateScopeBindingPattern('repo::mthines/lorekit');
    expect(result).toEqual({ ok: true, normalized: 'repo::mthines/lorekit' });
  });

  it('normalizes case and surrounding whitespace', () => {
    const result = validateScopeBindingPattern('  Repo::Mthines/Lorekit  ');
    expect(result).toEqual({ ok: true, normalized: 'repo::mthines/lorekit' });
  });

  it('rejects a malformed wildcard — star not directly after "/" or "::"', () => {
    const result = validateScopeBindingPattern('repo::bad*');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-canonical exact scope — unknown prefix', () => {
    // Passes the shape-only wildcard grammar's charset were it treated as a
    // pattern, but it is NOT a wildcard (no trailing '*') and is not a legal
    // scope prefix either — ScopeSchema must be the one that catches it.
    const result = validateScopeBindingPattern('notaprefix::x');
    expect(result.ok).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = validateScopeBindingPattern('   ');
    expect(result).toEqual({ ok: false, error: 'Scope is required' });
  });

  it('rejects "global" with a trailing wildcard star mid-token', () => {
    const result = validateScopeBindingPattern('repo::mthines/lore*');
    expect(result.ok).toBe(false);
  });
});
