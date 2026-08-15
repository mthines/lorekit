// The per-session hook state: one-shot markers and the shown-set.
//
// Both are best-effort bookkeeping on a path that must always exit 0, so the
// degradation rules below are the contract, not implementation detail.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The module reads CLAUDE_PLUGIN_DATA at call time, so each test can point it
// at a fresh directory and stay isolated from every other session on the box.
function isolate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-state-'));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return dir;
}

const state = await import('../src/core/state.mjs');
const { shownLessons, recordShownLessons, firstTimeThisSession, COMPACT_AT_BYTES } = state;

describe('the shown-set', () => {
  test('records ids and reads them back', () => {
    isolate();
    assert.deepEqual([...shownLessons('s1')], [], 'a fresh session has shown nothing');
    recordShownLessons('s1', ['global::a', 'repo::o/r::b']);
    assert.deepEqual([...shownLessons('s1')].sort(), ['global::a', 'repo::o/r::b']);
  });

  test('accumulates across calls — SessionStart and each prompt both contribute', () => {
    // "Already shown" has to mean shown by ANYTHING. A per-prompt hook that
    // only remembered its own output would resurface the SessionStart set one
    // lesson at a time.
    isolate();
    recordShownLessons('s1', ['global::from-session-start']);
    recordShownLessons('s1', ['global::from-turn-one']);
    assert.deepEqual(
      [...shownLessons('s1')].sort(),
      ['global::from-session-start', 'global::from-turn-one'],
    );
  });

  test('is keyed per session — one session cannot suppress another', () => {
    isolate();
    recordShownLessons('s1', ['global::a']);
    assert.deepEqual([...shownLessons('s2')], []);
  });

  test('a duplicate id is harmless — the reader is a Set', () => {
    // The writer is a bare append precisely so two racing hooks cannot corrupt
    // the file; that makes duplicates possible and they must not matter.
    isolate();
    recordShownLessons('s1', ['global::a']);
    recordShownLessons('s1', ['global::a', 'global::a']);
    assert.deepEqual([...shownLessons('s1')], ['global::a']);
  });

  test('an unreadable or missing state file fails toward showing, not hiding', () => {
    // A repeated lesson is a small annoyance. A lesson silently withheld
    // because a state file could not be read is the failure nobody diagnoses.
    isolate();
    assert.deepEqual([...shownLessons('never-written')], []);
    assert.deepEqual([...shownLessons(null)], [], 'no session id → no suppression');
    assert.deepEqual([...shownLessons(undefined)], []);
  });

  test('a missing session id or an empty list is a silent no-op', () => {
    isolate();
    assert.doesNotThrow(() => recordShownLessons(null, ['global::a']));
    assert.doesNotThrow(() => recordShownLessons('s1', []));
    assert.doesNotThrow(() => recordShownLessons('s1', null));
    assert.deepEqual([...shownLessons('s1')], []);
  });

  test('an id containing a newline is dropped, never written', () => {
    // The file is line-delimited, so a newline in an id would forge entries.
    isolate();
    recordShownLessons('s1', ['global::ok', 'global::b\nglobal::forged']);
    assert.deepEqual([...shownLessons('s1')], ['global::ok']);
  });

  test('the retained set is bounded, keeping the newest', () => {
    // A long session with a large store would otherwise grow the file without
    // bound, and re-showing a lesson from 600 injections ago is not the
    // repetition this guards against.
    isolate();
    const ids = Array.from({ length: 900 }, (_, i) => `global::k${i}`);
    recordShownLessons('s1', ids);
    const seen = shownLessons('s1');
    assert.ok(seen.size <= 500, `retained ${seen.size}`);
    assert.ok(seen.has('global::k899'), 'the newest is kept');
    assert.ok(!seen.has('global::k0'), 'the oldest is dropped');
  });

  test('the on-disk file is bounded by compaction, not just the read', () => {
    // The append-only writer keeps the hot path race-safe; without compaction a
    // long session would grow the file without bound. Drive it well past
    // COMPACT_AT_BYTES over many writes and assert the file shrinks back on its
    // own while the newest ids survive and the oldest are dropped. Sized off the
    // exported constant so raising the threshold cannot silently stop the test
    // from actually crossing it.
    const dir = isolate();
    const idsPerBatch = 1000;
    // Write ~2.5× the threshold so compaction is exercised regardless of value.
    const batches = Math.ceil((COMPACT_AT_BYTES * 2.5) / (idsPerBatch * 18));
    const lastId = `global::b${batches - 1}-k${idsPerBatch - 1}`;
    for (let batch = 0; batch < batches; batch++) {
      const ids = Array.from({ length: idsPerBatch }, (_, i) => `global::b${batch}-k${i}`);
      recordShownLessons('s1', ids);
    }
    const idsFile = fs.readdirSync(dir).find((f) => f.endsWith('.ids'));
    assert.ok(idsFile, 'the shown-set file exists');
    const size = fs.statSync(path.join(dir, idsFile)).size;
    assert.ok(size <= COMPACT_AT_BYTES, `file stayed bounded, compacted to ${size} bytes`);
    const seen = shownLessons('s1');
    assert.ok(seen.has(lastId), 'the newest id survived compaction');
    assert.ok(!seen.has('global::b0-k0'), 'the oldest id was dropped');
  });

  test('does not disturb the one-shot markers that share its directory', () => {
    isolate();
    recordShownLessons('s1', ['global::a']);
    assert.equal(firstTimeThisSession('s1', 'read'), true, 'the read marker is still unconsumed');
    assert.equal(firstTimeThisSession('s1', 'read'), false);
    assert.deepEqual([...shownLessons('s1')], ['global::a'], 'and the shown-set survived');
  });
});
