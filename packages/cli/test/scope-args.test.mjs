// The scope grammar and the scope/key argument parser — the ONE disambiguation
// rule `write`, `show` and `link` share (`src/lessons-pure.mjs`).
//
// This suite exists because the three commands did NOT share it. `link` used the
// validity-gated `resolveScopeArg`; `write` and `show` used a naive first-`::`
// split (`parseScopeKey`), which silently mis-parsed EVERY scope other than
// `global`:
//
//   write repo::owner/name my-key "body"
//     → scope "repo", key "owner/name", value "my-key", and "body" DISCARDED
//
// Every pre-existing test used `global`, the one scope where a first-`::` and a
// last-`::` split coincide, so nothing caught it. The cases below are therefore
// deliberately weighted towards multi-segment scopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeIssue,
  isScopeString,
  resolveScopeArg,
  resolveScopeKeyArgs,
} from '../src/shared/lessons-pure.mjs';
// Re-export sites: every command imports through one of these two, so a broken
// re-export is a broken command even with this module green.
import { scopeIssue as scopeIssueFromView, resolveScopeKeyArgs as fromView } from '../src/shared/lessons-view.mjs';
import { resolveScopeKeyArgs as fromDeeplink } from '../src/shared/deeplink-pure.mjs';

// ── scopeIssue: `::` is RESERVED as the segment separator ─────────────────────

test('scopeIssue accepts every canonical scope form', () => {
  assert.equal(scopeIssue('global'), null);
  assert.equal(scopeIssue('project::widget'), null);
  assert.equal(scopeIssue('repo::owner/name'), null);
  assert.equal(scopeIssue('branch::owner/name::main'), null);
  assert.equal(scopeIssue('branch::owner/name::feat/x'), null);
});

test('scopeIssue rejects a repo scope carrying a further `::` segment', () => {
  // THE hole this change closes. `repo::owner/name::my-key` satisfies the
  // `owner/name` shape on its own (the key rides along inside the name
  // segment), so without an explicit `::` check it read as a VALID scope — and
  // a valid left side is exactly what suppresses the shorthand split. The
  // result was a scope named `repo::owner/name::my-key` and a swallowed key.
  assert.match(scopeIssue('repo::owner/name::my-key'), /no further `::` segment/);
  // The pre-existing `project` rule this now mirrors.
  assert.match(scopeIssue('project::widget::my-key'), /no further `::` segment/);
});

test('scopeIssue rejects the malformed forms it always did', () => {
  assert.match(scopeIssue('repo::owneronly'), /owner\/name/);
  assert.match(scopeIssue('branch::owner/name'), /owner\/name::branch/);
  assert.match(scopeIssue('branch::owner/name::a::b'), /owner\/name::branch/);
  assert.match(scopeIssue('repo:owner/name'), /single `:` separator/);
  assert.match(scopeIssue('foo'), /unrecognized scope type/);
  assert.match(scopeIssue(''), /empty scope/);
  assert.match(scopeIssue(null), /empty scope/);
});

test('isScopeString is the predicate form of scopeIssue', () => {
  assert.equal(isScopeString('branch::owner/name::main'), true);
  assert.equal(isScopeString('global::my-key'), false, '`global` takes no segment');
  assert.equal(isScopeString('repo::owner/name::my-key'), false);
});

// ── resolveScopeArg: the single-token split ───────────────────────────────────

test('resolveScopeArg: a bare valid scope is never mis-split into a bogus key', () => {
  assert.deepEqual(resolveScopeArg('global'), { scope: 'global', key: null });
  assert.deepEqual(resolveScopeArg('repo::owner/name'), { scope: 'repo::owner/name', key: null });
  assert.deepEqual(resolveScopeArg('branch::owner/name::main'), {
    scope: 'branch::owner/name::main',
    key: null,
  });
});

test('resolveScopeArg: the shorthand splits at the LAST `::`, keeping the scope whole', () => {
  assert.deepEqual(resolveScopeArg('global::my-key'), { scope: 'global', key: 'my-key' });
  assert.deepEqual(resolveScopeArg('repo::owner/name::my-key'), {
    scope: 'repo::owner/name',
    key: 'my-key',
  });
  assert.deepEqual(resolveScopeArg('branch::owner/name::main::my-key'), {
    scope: 'branch::owner/name::main',
    key: 'my-key',
  });
});

test('resolveScopeArg: an unresolvable arg becomes the scope, never a fabricated key', () => {
  assert.deepEqual(resolveScopeArg('repo::owneronly'), { scope: 'repo::owneronly', key: null });
  assert.deepEqual(resolveScopeArg('global::'), { scope: 'global::', key: null });
  assert.deepEqual(resolveScopeArg(''), { scope: null, key: null });
  assert.deepEqual(resolveScopeArg('   '), { scope: null, key: null });
});

test('resolveScopeArg defaults to the real validator (no predicate needed)', () => {
  // It used to require an injected `isScope`, defaulting to `() => false` —
  // i.e. a caller that forgot the argument silently got "never split".
  assert.deepEqual(resolveScopeArg('global::my-key'), { scope: 'global', key: 'my-key' });
});

// ── resolveScopeKeyArgs: positionals + flags ──────────────────────────────────

test('resolveScopeKeyArgs: one positional is the shorthand, and reports consuming it', () => {
  assert.deepEqual(resolveScopeKeyArgs(['global::my-key']), {
    scope: 'global',
    key: 'my-key',
    consumed: 1,
  });
  assert.deepEqual(resolveScopeKeyArgs(['repo::owner/name::my-key']), {
    scope: 'repo::owner/name',
    key: 'my-key',
    consumed: 1,
  });
});

test('resolveScopeKeyArgs: a first positional that IS a valid scope takes the second as the key', () => {
  assert.deepEqual(resolveScopeKeyArgs(['global', 'my-key']), {
    scope: 'global',
    key: 'my-key',
    consumed: 2,
  });
  assert.deepEqual(resolveScopeKeyArgs(['repo::owner/name', 'my-key']), {
    scope: 'repo::owner/name',
    key: 'my-key',
    consumed: 2,
  });
  assert.deepEqual(resolveScopeKeyArgs(['branch::owner/name::main', 'my-key']), {
    scope: 'branch::owner/name::main',
    key: 'my-key',
    consumed: 2,
  });
});

test('resolveScopeKeyArgs: the shorthand plus a trailing value is not read as scope+key', () => {
  // The case that makes the scope-validity gate necessary rather than merely
  // nice: `write global::my-key "body"` and `write global my-key "body"` are
  // both two-or-three positionals, and only the validity of the FIRST token
  // tells them apart. `consumed` is what lets `write` find its value in both.
  assert.deepEqual(resolveScopeKeyArgs(['global::my-key', 'body']), {
    scope: 'global',
    key: 'my-key',
    consumed: 1,
  });
  assert.deepEqual(resolveScopeKeyArgs(['global', 'my-key', 'body']), {
    scope: 'global',
    key: 'my-key',
    consumed: 2,
  });
  assert.deepEqual(resolveScopeKeyArgs(['repo::owner/name', 'my-key', 'body']), {
    scope: 'repo::owner/name',
    key: 'my-key',
    consumed: 2,
  });
  assert.deepEqual(resolveScopeKeyArgs(['repo::owner/name::my-key', 'body']), {
    scope: 'repo::owner/name',
    key: 'my-key',
    consumed: 1,
  });
});

test('resolveScopeKeyArgs: a scope-only positional yields a null key', () => {
  assert.deepEqual(resolveScopeKeyArgs(['global']), { scope: 'global', key: null, consumed: 1 });
  assert.deepEqual(resolveScopeKeyArgs(['repo::owner/name']), {
    scope: 'repo::owner/name',
    key: null,
    consumed: 1,
  });
});

test('resolveScopeKeyArgs: an invalid scope is passed through for the caller to report', () => {
  // Never a fabricated key and never a throw — the command runs `scopeIssue`
  // and prints the real reason.
  assert.deepEqual(resolveScopeKeyArgs(['foo', 'bar']), { scope: 'foo', key: null, consumed: 1 });
  assert.deepEqual(resolveScopeKeyArgs(['repo:owner/name']), {
    scope: 'repo:owner/name',
    key: null,
    consumed: 1,
  });
});

test('resolveScopeKeyArgs: no positionals and no flags yields an empty scope', () => {
  assert.deepEqual(resolveScopeKeyArgs([]), { scope: '', key: null, consumed: 0 });
  assert.deepEqual(resolveScopeKeyArgs(['  ']), { scope: '', key: null, consumed: 0 });
  assert.deepEqual(resolveScopeKeyArgs(), { scope: '', key: null, consumed: 0 });
});

test('resolveScopeKeyArgs: both flags win and consume NO positional', () => {
  // The escape hatch: a key containing `::` is unrepresentable in the
  // single-token form (the split would claim part of it as the scope), so the
  // flags must bypass the parse entirely.
  assert.deepEqual(
    resolveScopeKeyArgs(['ignored'], { scope: 'global', key: 'loop::aw-lessons' }),
    { scope: 'global', key: 'loop::aw-lessons', consumed: 0 },
  );
});

test('resolveScopeKeyArgs: one flag takes the other half from the first positional VERBATIM', () => {
  // A flag on either side removes the ambiguity, so no split is attempted —
  // `--key` makes the positional the whole scope even when it contains `::`.
  assert.deepEqual(resolveScopeKeyArgs(['global::odd'], { key: 'my-key' }), {
    scope: 'global::odd',
    key: 'my-key',
    consumed: 1,
  });
  assert.deepEqual(resolveScopeKeyArgs(['my::key'], { scope: 'global' }), {
    scope: 'global',
    key: 'my::key',
    consumed: 1,
  });
  assert.deepEqual(resolveScopeKeyArgs([], { scope: 'global' }), {
    scope: 'global',
    key: null,
    consumed: 0,
  });
});

test('resolveScopeKeyArgs: non-string positionals are ignored, never coerced', () => {
  assert.deepEqual(resolveScopeKeyArgs([undefined, 'x']), { scope: '', key: null, consumed: 0 });
  assert.deepEqual(resolveScopeKeyArgs(['global', 42]), { scope: 'global', key: null, consumed: 1 });
});

test('resolveScopeKeyArgs trims surrounding whitespace on both halves', () => {
  assert.deepEqual(resolveScopeKeyArgs([' global ', ' my-key ']), {
    scope: 'global',
    key: 'my-key',
    consumed: 2,
  });
});

// ── re-export parity ──────────────────────────────────────────────────────────

test('the lessons-view and deeplink-pure re-exports are the same functions', () => {
  // `write`/`show` import from `lessons-view.mjs`, `link` from
  // `deeplink-pure.mjs`. Both must resolve to this module or the commands can
  // drift again behind a green unit suite.
  assert.equal(fromView, resolveScopeKeyArgs);
  assert.equal(fromDeeplink, resolveScopeKeyArgs);
  assert.equal(scopeIssueFromView, scopeIssue);
});
