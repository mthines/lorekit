// Unit tests for the BYOD bootstrap generator's pure logic.
//   node --test supabase/byod/generate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseMigrationName,
  renderBootstrap as render,
  readMigrations,
  OUTPUT_PATH,
  OVERLAY_PATH,
} from './generate.mjs';

const OVERLAY = '-- overlay\ndo $o$ begin perform 1; end $o$;\n';
const renderBootstrap = (migrations, overlay = OVERLAY) => render(migrations, overlay);

test('parseMigrationName follows the Supabase CLI grammar', () => {
  assert.deepEqual(parseMigrationName('00001_memories.sql'), { version: '00001', name: 'memories' });
  assert.deepEqual(parseMigrationName('00113_a_b_c.sql'), { version: '00113', name: 'a_b_c' });
  assert.equal(parseMigrationName('README.md'), null);
  assert.equal(parseMigrationName('memories.sql'), null);
  assert.deepEqual(parseMigrationName('00002_.sql'), { version: '00002', name: '' }, 'CLI accepts an empty name');
});

test('renderBootstrap keeps migrations verbatim, in order, inside one transaction', () => {
  const out = renderBootstrap([
    { file: '00001_first.sql', sql: 'create table a (id int);' },
    { file: '00002_second.sql', sql: 'create table b (id int);\n' },
  ]);
  const a = out.indexOf('create table a (id int);');
  const b = out.indexOf('create table b (id int);');
  assert.ok(a > 0 && b > a, 'migrations appear in the given order');
  assert.ok(out.indexOf('\nbegin;\n') < a, 'transaction opens before the first migration');
  assert.ok(out.trimEnd().endsWith('commit;'), 'transaction commits at the end');
  assert.equal(out.match(/^begin;$/gm).length, 1, 'exactly one transaction');
});

test('renderBootstrap records every version in the Supabase migration history', () => {
  const out = renderBootstrap([
    { file: '00001_first.sql', sql: 'select 1;' },
    { file: '00002_it\'s.sql', sql: 'select 2;' },
  ]);
  assert.match(out, /values \('00001', 'first'\)/);
  assert.match(out, /values \('00002', 'it''s'\)/, 'quotes are escaped');
  assert.match(out, /create table if not exists supabase_migrations\.schema_migrations/);
});

test('renderBootstrap guards against re-running on an initialised database', () => {
  const out = renderBootstrap([{ file: '00001_first.sql', sql: 'select 1;' }]);
  const guard = out.indexOf("to_regclass('public.memories') is not null");
  assert.ok(guard > 0 && guard < out.indexOf('select 1;'), 'guard runs before any migration');
});

test('renderBootstrap normalises CRLF and a BOM, and terminates an unterminated last statement', () => {
  const out = renderBootstrap([{ file: '00001_first.sql', sql: '\uFEFFselect 1;\r\nselect 2' }]);
  assert.ok(!out.includes('\r') && !out.includes('\uFEFF'));
  assert.match(out, /select 2\n;\ninsert into supabase_migrations/);
});

test('renderBootstrap rejects two migrations with one version', () => {
  assert.throws(
    () => renderBootstrap([
      { file: '00114_a.sql', sql: 'select 1;' },
      { file: '00114_b.sql', sql: 'select 2;' },
    ]),
    /duplicate migration version 00114/,
  );
});

test('renderBootstrap ends with the storage overlay, after every migration and inside the transaction', () => {
  const out = renderBootstrap([{ file: '00001_first.sql', sql: 'select 1;' }]);
  const history = out.lastIndexOf("values ('00001', 'first')");
  const overlay = out.indexOf('do $o$ begin perform 1; end $o$;');
  assert.ok(overlay > history, 'overlay runs after the last migration is recorded');
  assert.ok(overlay < out.lastIndexOf('commit;'), 'overlay is inside the transaction');
  assert.throws(() => render([{ file: '00001_first.sql', sql: 'select 1;' }], ''), /no storage overlay/);
});

test('the overlay finds the foreign keys by query, never by a hard-coded name', () => {
  const overlay = fs.readFileSync(OVERLAY_PATH, 'utf8').replace(/^\s*--.*$/gm, '');
  assert.match(overlay, /confrelid = 'auth\.users'::regclass/);
  assert.match(overlay, /nspname = 'public'/);
  assert.doesNotMatch(overlay, /_fkey/, 'a named constraint would miss the next migration\'s user FK');
});

test('renderBootstrap is deterministic and rejects bad input', () => {
  const input = [{ file: '00001_first.sql', sql: 'select 1;' }];
  assert.equal(renderBootstrap(input), renderBootstrap(input));
  assert.throws(() => renderBootstrap([]), /no migrations/);
  assert.throws(() => renderBootstrap([{ file: 'nope.sql', sql: '' }]), /not a migration filename/);
});

test('the committed bootstrap.sql is generated from the current migrations', () => {
  assert.equal(
    fs.readFileSync(OUTPUT_PATH, 'utf8'),
    render(readMigrations(), fs.readFileSync(OVERLAY_PATH, 'utf8')),
    'run: node supabase/byod/generate.mjs',
  );
});
