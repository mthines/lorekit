// Unit tests for the BYOD bootstrap generator's pure logic.
//   node --test scripts/codegen/gen-byod-bootstrap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseMigrationName,
  renderBootstrap,
  readMigrations,
  OUTPUT_PATH,
} from './gen-byod-bootstrap.mjs';

test('parseMigrationName follows the Supabase CLI grammar', () => {
  assert.deepEqual(parseMigrationName('00001_memories.sql'), { version: '00001', name: 'memories' });
  assert.deepEqual(parseMigrationName('00113_a_b_c.sql'), { version: '00113', name: 'a_b_c' });
  assert.equal(parseMigrationName('README.md'), null);
  assert.equal(parseMigrationName('memories.sql'), null);
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

test('renderBootstrap is deterministic and rejects bad input', () => {
  const input = [{ file: '00001_first.sql', sql: 'select 1;' }];
  assert.equal(renderBootstrap(input), renderBootstrap(input));
  assert.throws(() => renderBootstrap([]), /no migrations/);
  assert.throws(() => renderBootstrap([{ file: 'nope.sql', sql: '' }]), /not a migration filename/);
});

test('the committed bootstrap.sql is generated from the current migrations', () => {
  assert.equal(
    fs.readFileSync(OUTPUT_PATH, 'utf8'),
    renderBootstrap(readMigrations()),
    'run: node scripts/codegen/gen-byod-bootstrap.mjs',
  );
});
