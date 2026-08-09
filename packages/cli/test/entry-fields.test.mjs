// The pure store read-field projection. These are the total-function
// guarantees the two stores rely on: this code runs on the SessionStart hot
// path behind a hook that must always exit 0, so every input below has to
// produce an answer rather than an exception.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seenCountOf, updatedAtOf, withReadFields } from '../src/store/entry-fields.mjs';

describe('seenCountOf', () => {
  test('reads a plain count', () => {
    assert.equal(seenCountOf({ seen_count: 1 }), 1);
    assert.equal(seenCountOf({ seen_count: 42 }), 42);
  });

  test('absent is 0, not 1 — no evidence rather than one sighting', () => {
    // A live remote row always carries at least 1 (the column is NOT NULL
    // DEFAULT 1), so 0 can only mean "this store did not tell me". A salience
    // score must be able to tell those apart.
    assert.equal(seenCountOf({}), 0);
    assert.equal(seenCountOf({ seen_count: null }), 0);
    assert.equal(seenCountOf({ seen_count: undefined }), 0);
  });

  test('coerces a numeric string — PostgREST can render a bigint as text', () => {
    assert.equal(seenCountOf({ seen_count: '5' }), 5);
    assert.equal(seenCountOf({ seen_count: ' 5 ' }), 5);
  });

  test('a count is a tally: floored, never negative', () => {
    assert.equal(seenCountOf({ seen_count: 2.7 }), 2);
    assert.equal(seenCountOf({ seen_count: -3 }), 0);
    assert.equal(seenCountOf({ seen_count: -0.5 }), 0);
  });

  test('unusable input degrades to 0 instead of throwing', () => {
    for (const bad of [null, undefined, 0, '', 'nope', [], () => {}]) {
      assert.equal(seenCountOf(bad), 0, `input ${String(bad)}`);
    }
    for (const bad of ['lots', {}, [], NaN, Infinity, -Infinity, true]) {
      assert.equal(seenCountOf({ seen_count: bad }), 0, `seen_count ${String(bad)}`);
    }
  });
});

describe('updatedAtOf', () => {
  test('reads either store spelling and normalises to ISO', () => {
    const iso = '2026-08-01T10:20:30.000Z';
    assert.equal(updatedAtOf({ updated_at: iso }), iso, 'remote');
    assert.equal(updatedAtOf({ updated: iso }), iso, 'local');
    assert.equal(updatedAtOf({ updated_at: '2026-08-01T10:20:30Z' }), iso, 'normalised');
  });

  test('the remote spelling wins when a row somehow carries both', () => {
    assert.equal(
      updatedAtOf({ updated_at: '2026-08-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z' }),
      '2026-08-01T00:00:00.000Z',
    );
  });

  test('an unparseable or absent value is null, never Invalid Date', () => {
    // A recency decay fed NaN silently sinks the entry to the bottom of the
    // ranking, which is a worse failure than admitting the timestamp is
    // unknown and letting the caller decide.
    for (const bad of [undefined, null, '', 'yesterday', 'not-a-date', {}, []]) {
      assert.equal(updatedAtOf({ updated_at: bad }), null, `value ${JSON.stringify(bad)}`);
    }
    assert.equal(updatedAtOf({}), null);
    assert.equal(updatedAtOf(null), null);
    assert.equal(updatedAtOf(undefined), null);
  });
});

describe('withReadFields', () => {
  test('is additive — every original key survives untouched', () => {
    const row = {
      id: 'i1', scope: 'global', key: 'k', value: 'v', tags: ['a'],
      seen_count: 4, updated_at: '2026-08-01T10:20:30.000Z', org: null,
    };
    const out = withReadFields(row);
    for (const [k, v] of Object.entries(row)) {
      assert.deepEqual(out[k], v, `original key ${k} must survive`);
    }
    assert.equal(out.seenCount, 4);
    assert.equal(out.updatedAt, '2026-08-01T10:20:30.000Z');
  });

  test('does not mutate its input', () => {
    const row = { key: 'k', seen_count: 2 };
    withReadFields(row);
    assert.deepEqual(row, { key: 'k', seen_count: 2 });
  });

  test('a non-object row yields the defaults rather than throwing', () => {
    for (const bad of [null, undefined, 'str', 7, true]) {
      assert.deepEqual(withReadFields(bad), { seenCount: 0, updatedAt: null }, `input ${String(bad)}`);
    }
  });
});

test('entry-fields imports nothing at all', async () => {
  // The projection sits on the SessionStart hot path, which deliberately pulls
  // in only the dependency-free modules. An import here is not a style
  // preference — it is weight on every session start, and a way for this
  // module to acquire a throwing dependency.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    fileURLToPath(new URL('../src/store/entry-fields.mjs', import.meta.url)),
    'utf8',
  );
  // Anti-vacuity: prove we read the real module before asserting on its imports.
  assert.match(src, /export function withReadFields/);

  // A module specifier arrives in exactly two shapes: something `from '…'`
  // (covering `import x from`, `import {x} from`, and `export … from`, with or
  // without a space after the keyword), or a bare side-effect `import '…'`.
  // Anchoring on the leading keyword keeps prose in a `//` or ` *` comment line
  // from matching. `^\s*import\s` alone missed `export … from` and
  // `import{x}from'y'` — both give the module a real dependency.
  const moduleDeps = (src) => [
    ...(src.match(/^[ \t]*(?:import|export)\b[^\n]*\bfrom\s*['"]/gm) || []),
    ...(src.match(/^[ \t]*import\s*['"]/gm) || []),
  ];

  // The detector is the assertion, so prove it still detects before trusting a
  // zero. Each sample is a shape a dependency could really take.
  for (const sample of [
    "import fs from 'node:fs';",
    "import { readFileSync } from 'node:fs';",
    "import{x}from'y';",
    "export { a } from './a.mjs';",
    "export * from './a.mjs';",
    "import 'node:fs';",
  ]) {
    assert.equal(moduleDeps(sample).length, 1, `detector missed: ${sample}`);
  }
  assert.equal(moduleDeps('// import fs from "node:fs"\n * export x from "y"\n').length, 0);

  assert.deepEqual(
    moduleDeps(src),
    [],
    'entry-fields.mjs must stay dependency-free (no imports, not even node builtins)',
  );
});
