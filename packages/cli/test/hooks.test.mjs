import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFailure } from '../src/core/failure.mjs';
import { formatLessons, retrospectiveNudge, failureNudge } from '../src/core/lessons.mjs';
import { claude } from '../src/adapters/claude.mjs';
import { cursor } from '../src/adapters/cursor.mjs';
import { codex } from '../src/adapters/codex.mjs';

test('isFailure reads exit codes and error flags conservatively', () => {
  assert.equal(isFailure('Bash', { exit_code: 1 }), true);
  assert.equal(isFailure('Bash', { exit_code: 0 }), false);
  assert.equal(isFailure('Bash', { exitCode: 2 }), true);
  assert.equal(isFailure('X', { is_error: true }), true);
  assert.equal(isFailure('X', { status: 'error' }), true);
  assert.equal(isFailure('X', { status: 'success' }), false);
  assert.equal(isFailure('X', { interrupted: true }), false); // user abort, not a lesson
  assert.equal(isFailure('X', {}), false);
  assert.equal(isFailure('X', null), false);
});

test('formatLessons returns null when empty and a block otherwise', () => {
  assert.equal(formatLessons([], { repoScope: 'repo::a/b' }), null);
  const out = formatLessons(
    [{ key: 'k1', value: 'first line\nsecond', scope: 'repo::a/b' }],
    { repoScope: 'repo::a/b' },
  );
  assert.match(out, /k1/);
  assert.match(out, /repo::a\/b/);
  assert.match(out, /considerations, not rules/);
  assert.doesNotMatch(out, /second/); // only the first line is included
});

test('nudges name the write scope', () => {
  assert.match(retrospectiveNudge({ repoScope: 'repo::a/b' }), /memory\.write to repo::a\/b/);
  assert.match(failureNudge('Bash', { repoScope: null }), /memory\.write to global/);
});

test('adapter event → intent mapping', () => {
  assert.equal(claude.intentFor('SessionStart'), 'read');
  assert.equal(claude.intentFor('PostToolUse'), 'failure');
  assert.equal(claude.intentFor('PostToolUseFailure'), 'failure');
  assert.equal(claude.intentFor('Stop'), 'retrospective');
  assert.equal(claude.intentFor('Whatever'), 'noop');

  assert.equal(codex.intentFor('SessionStart'), 'read');
  assert.equal(codex.intentFor('Stop'), 'retrospective');

  assert.equal(cursor.intentFor('beforeSubmitPrompt'), 'read');
  assert.equal(cursor.intentFor('stop'), 'retrospective');
  assert.equal(cursor.intentFor('beforeShellExecution'), 'noop');
});

test('adapters emit their framework-specific output shape', () => {
  assert.deepEqual(JSON.parse(claude.emit('Stop', 'hi')), {
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'hi' },
  });
  assert.deepEqual(JSON.parse(codex.emit('SessionStart', 'hi')), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' },
  });
  assert.deepEqual(JSON.parse(cursor.emit('stop', 'hi')), { followup_message: 'hi' });
});

test('adapters normalize their native stdin fields', () => {
  const c = claude.parse({ cwd: '/p', session_id: 's', tool_name: 'Bash', tool_response: { exit_code: 1 } });
  assert.equal(c.cwd, '/p');
  assert.equal(c.sessionId, 's');
  assert.equal(c.toolName, 'Bash');

  const cu = cursor.parse({ generation_id: 'g', workspace_roots: ['/w'] });
  assert.equal(cu.sessionId, 'g');
  assert.equal(cu.cwd, '/w');
});
