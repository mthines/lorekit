import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDataset } from './preview-dataset.mjs';
import {
  sqlString,
  renderOrgSql,
  renderMemoriesSql,
  renderReadDailySql,
  renderCitationsSql,
  renderUsageEventsSql,
  renderResetSql,
} from './preview-sql.mjs';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const USER_ID = '11111111-1111-4111-8111-111111111111';

test('sqlString escapes embedded single quotes and maps null/undefined to SQL NULL', () => {
  assert.equal(sqlString("it's here"), "'it''s here'");
  assert.equal(sqlString(null), 'null');
  assert.equal(sqlString(undefined), 'null');
  assert.equal(sqlString('plain'), "'plain'");
});

test('renderMemoriesSql never leaves a raw quote unescaped, for every seeded value', () => {
  const { memories } = buildDataset({ now: NOW });
  // Inject one adversarial value to prove the escaping path, without hand
  // maintaining a second fixture dataset.
  memories[0].value = "a lesson with a ' quote and -- a comment marker";
  const sql = renderMemoriesSql(memories, USER_ID);
  // A raw, unescaped `'` immediately followed by non-`'` inside the literal
  // would break the statement — the only correct escape is doubling it.
  assert.ok(sql.includes("a lesson with a '' quote"), 'single quote was not doubled');
  assert.ok(sql.includes('on conflict on constraint memories_user_scope_key_unique do update set'));
  assert.ok(!sql.includes('created_at = excluded.created_at'), 'created_at must never be overwritten on conflict');
});

test('renderMemoriesSql includes every seeded memory as one VALUES row', () => {
  const { memories } = buildDataset({ now: NOW });
  const sql = renderMemoriesSql(memories, USER_ID);
  // count occurrences of the id prefix used by every seeded row
  const idMatches = sql.match(/00000000-0000-4000-8000-/g) ?? [];
  assert.equal(idMatches.length, memories.length);
});

test('renderReadDailySql and renderCitationsSql scope their DELETE to the given memory ids only', () => {
  const { memories, readDaily, citations } = buildDataset({ now: NOW });
  const ids = memories.map((m) => m.id);
  const readSql = renderReadDailySql(readDaily, ids);
  const citeSql = renderCitationsSql(citations, ids, USER_ID);
  assert.match(readSql, /delete from memory_read_daily where memory_id = any\(/);
  assert.match(citeSql, /delete from memory_citations where cited_memory_id = any\(/);
  for (const id of ids) {
    assert.ok(readSql.includes(id), `read_daily delete is missing memory id ${id}`);
  }
});

test('renderCitationsSql fills in the NOT NULL user_id column', () => {
  const { memories, citations } = buildDataset({ now: NOW });
  const ids = memories.map((m) => m.id);
  const sql = renderCitationsSql(citations, ids, USER_ID);
  assert.match(sql, /insert into memory_citations \(user_id, cited_memory_id, citing_memory_id, correlation_id, created_at\)/);
  assert.ok(sql.includes(USER_ID), 'citations insert is missing the seeded user_id');
});

test('renderUsageEventsSql scopes its DELETE to the seeded user AND the seed correlation prefix', () => {
  const { usageEvents } = buildDataset({ now: NOW });
  const sql = renderUsageEventsSql(usageEvents, USER_ID);
  assert.ok(sql.includes(USER_ID));
  assert.ok(sql.includes('preview-seed-%'));
});

test('renderOrgSql upserts on the org\'s primary key, never on slug alone', () => {
  const { org } = buildDataset({ now: NOW });
  const sql = renderOrgSql(org, USER_ID);
  assert.match(sql, /on conflict \(id\) do update/);
});

test('renderResetSql deletes exactly the seed-prefixed memories, seed-prefixed usage events, and the seed org', () => {
  const { org } = buildDataset({ now: NOW });
  const sql = renderResetSql(org, USER_ID);
  assert.ok(sql.includes('preview-seed/%'));
  assert.ok(sql.includes('preview-seed-%'));
  assert.ok(sql.includes(org.id));
  assert.ok(sql.includes(USER_ID));
});

test('renderResetSql scopes the org delete to created_by, so one user cannot drop another user\'s shared org', () => {
  const { org } = buildDataset({ now: NOW });
  const sql = renderResetSql(org, USER_ID);
  assert.match(sql, new RegExp(`delete from orgs where id = '${org.id}' and created_by = '${USER_ID}';`));
});
