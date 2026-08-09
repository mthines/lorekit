// `lorekit migrate` — dry-run/apply/idempotency and scope routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, sameEntry, COMPARED_FIELDS } from '../src/migrate.mjs';
import { createLocalStore } from '../src/store/local.mjs';
import { FIELDS } from '../src/store/format.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-mig-'));
}

// Silence migrate's stdout/stderr for the duration of `fn`.
async function quiet(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = errw;
  }
}

// Seed a source store with two entries across two scopes.
function seedSource() {
  const src = tmpDir();
  const s = createLocalStore(src);
  return Promise.all([
    s.write({ scope: 'global', key: 'g1', value: 'gv', tags: ['x'] }),
    s.write({ scope: 'repo::o/r', key: 'r1', value: 'rv', tags: ['y'] }),
  ]).then(() => src);
}

function withHome(home, fn) {
  const prev = process.env.LOREKIT_HOME;
  const prevStore = process.env.LOREKIT_STORE;
  process.env.LOREKIT_HOME = home;
  delete process.env.LOREKIT_STORE;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.LOREKIT_HOME;
      else process.env.LOREKIT_HOME = prev;
      if (prevStore === undefined) delete process.env.LOREKIT_STORE;
      else process.env.LOREKIT_STORE = prevStore;
    });
}

test('migrate --to home: dry-run writes nothing, --yes applies, re-run is idempotent', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    // Dry-run: no writes.
    await quiet(() => migrate({ from: src, to: 'home', dir: root }));
    assert.equal(createLocalStore(home).getEntry({ scope: 'global', key: 'g1' }), null);

    // Apply.
    await quiet(() => migrate({ from: src, to: 'home', apply: true, dir: root }));
    const dest = createLocalStore(home);
    assert.equal(dest.getEntry({ scope: 'global', key: 'g1' }).value, 'gv');
    assert.equal(dest.getEntry({ scope: 'repo::o/r', key: 'r1' }).value, 'rv');

    // Idempotent: a second apply leaves the entries byte-identical.
    const before = dest.getEntry({ scope: 'global', key: 'g1' });
    await quiet(() => migrate({ from: src, to: 'home', apply: true, dir: root }));
    const after = createLocalStore(home).getEntry({ scope: 'global', key: 'g1' });
    assert.deepEqual(after, before);
    assert.equal((await createLocalStore(home).list({ scope: 'global' })).entries.length, 1);
  });
});

test('migrate default routing: global→home; repo→home when project not opted-in', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir(); // no .lorekit/ under root → project tier not opted-in

  await withHome(home, async () => {
    await quiet(() => migrate({ from: src, apply: true, dir: root }));
    const dest = createLocalStore(home);
    assert.equal(dest.getEntry({ scope: 'global', key: 'g1' }).value, 'gv');
    assert.equal(dest.getEntry({ scope: 'repo::o/r', key: 'r1' }).value, 'rv');
    // Nothing landed in a project dir (it does not exist).
    assert.equal(fs.existsSync(path.join(root, '.lorekit')), false);
  });
});

test('migrate --to project creates the opted-in project dir on apply', async () => {
  const src = await seedSource();
  const home = tmpDir();
  const root = tmpDir();

  await withHome(home, async () => {
    await quiet(() => migrate({ from: src, to: 'project', apply: true, dir: root }));
    const proj = createLocalStore(path.join(root, '.lorekit'));
    assert.equal(proj.getEntry({ scope: 'repo::o/r', key: 'r1' }).value, 'rv');
    assert.equal(proj.getEntry({ scope: 'global', key: 'g1' }).value, 'gv');
  });
});

test('migrate relocates a differing seen_count instead of calling the entry unchanged', async () => {
  const srcDir = tmpDir();
  const s = createLocalStore(srcDir);
  for (const value of ['gv', 'gv', 'gv']) await s.write({ scope: 'global', key: 'g1', value });
  const entry = s.getEntry({ scope: 'global', key: 'g1' });
  assert.equal(entry.seen_count, 3);

  // A destination holding the SAME entry in every respect but the tally — the
  // case `sameEntry` used to classify `noop`, stranding the source's count.
  const home = tmpDir();
  await createLocalStore(home).putEntry({ ...entry, seen_count: 1 });

  await withHome(home, async () => {
    await quiet(() => migrate({ from: srcDir, to: 'home', apply: true, dir: tmpDir() }));
    const dest = createLocalStore(home);
    assert.equal(
      dest.getEntry({ scope: 'global', key: 'g1' }).seen_count,
      3,
      'migrate relocates a store, so it relocates the count too',
    );

    // Still idempotent: the relocated entry now matches, so a re-run moves nothing.
    await quiet(() => migrate({ from: srcDir, to: 'home', apply: true, dir: tmpDir() }));
    assert.equal(dest.getEntry({ scope: 'global', key: 'g1' }).seen_count, 3);
  });
});

test('migrate treats an absent and a zero seen_count as the same non-evidence', async () => {
  const srcDir = tmpDir();
  const s = createLocalStore(srcDir);
  await s.write({ scope: 'global', key: 'g1', value: 'gv' });
  const entry = s.getEntry({ scope: 'global', key: 'g1' });

  // A pre-column source file (no count at all) against a destination carrying 0
  // must stay `noop` — otherwise every run would rewrite every legacy entry.
  const home = tmpDir();
  await createLocalStore(home).putEntry({ ...entry, seen_count: 0 });
  const srcFileDir = path.join(srcDir, 'global');
  const srcFile = path.join(srcFileDir, fs.readdirSync(srcFileDir)[0]);
  fs.writeFileSync(
    srcFile,
    fs.readFileSync(srcFile, 'utf8').split('\n').filter((l) => !l.startsWith('seen_count:')).join('\n'),
  );

  await withHome(home, async () => {
    await quiet(() => migrate({ from: srcDir, to: 'home', apply: true, dir: tmpDir() }));
    assert.equal(createLocalStore(home).getEntry({ scope: 'global', key: 'g1' }).seen_count, 0);
  });
});

test('sameEntry compares every non-identity column putEntry relocates', () => {
  // `scope`/`key` are the identity the two entries were looked up by; `value` is
  // the body and is compared separately. Everything else must be in the set, or
  // an entry differing only in the missing column is a silent `noop`.
  const identity = ['scope', 'key'];
  assert.deepEqual(
    [...COMPARED_FIELDS].sort(),
    FIELDS.filter((f) => !identity.includes(f)).sort(),
    'add the new format.mjs column to COMPARED_FIELDS and to sameEntry\u2019s norm()',
  );

  // Anti-vacuity: the list above only pays off if sameEntry actually reads it.
  const base = {
    scope: 'global',
    key: 'k',
    value: 'v',
    tags: ['a'],
    source_agent: 'agent',
    trigger: 'manual',
    origin_repo: 'o/r',
    origin_branch: 'main',
    origin_commit: 'abc1234',
    origin_pr: 1,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
    archived_at: null,
    expires_at: '2026-06-01T00:00:00.000Z',
    seen_count: 2,
  };
  assert.equal(sameEntry(base, { ...base }), true);
  for (const field of COMPARED_FIELDS) {
    const changed = { ...base, [field]: field === 'tags' ? ['b'] : 'changed' };
    assert.equal(sameEntry(base, changed), false, `sameEntry ignores ${field}`);
  }
  assert.equal(sameEntry(base, { ...base, value: 'other' }), false);
});

test('migrate relocates an entry differing only in expires_at or origin', async () => {
  const srcDir = tmpDir();
  const s = createLocalStore(srcDir);
  await s.write({ scope: 'global', key: 'g1', value: 'gv' });
  const entry = {
    ...s.getEntry({ scope: 'global', key: 'g1' }),
    expires_at: '2026-12-31T00:00:00.000Z',
    origin_repo: 'mthines/lorekit',
    origin_pr: 407,
  };
  fs.writeFileSync(
    path.join(srcDir, 'global', fs.readdirSync(path.join(srcDir, 'global'))[0]),
    // Round-trip through putEntry so the source file really carries the columns.
    fs.readFileSync(
      await (async () => {
        const staging = tmpDir();
        await createLocalStore(staging).putEntry(entry);
        return path.join(staging, 'global', fs.readdirSync(path.join(staging, 'global'))[0]);
      })(),
      'utf8',
    ),
  );

  // The destination holds the same entry with NO TTL and no provenance — the
  // case `sameEntry` used to classify `noop`, dropping both on the floor.
  const home = tmpDir();
  await createLocalStore(home).putEntry({
    ...entry,
    expires_at: null,
    origin_repo: null,
    origin_pr: null,
  });

  await withHome(home, async () => {
    await quiet(() => migrate({ from: srcDir, to: 'home', apply: true, dir: tmpDir() }));
    const dest = createLocalStore(home).getEntry({ scope: 'global', key: 'g1' });
    assert.equal(dest.expires_at, '2026-12-31T00:00:00.000Z');
    assert.equal(dest.origin_repo, 'mthines/lorekit');
    assert.equal(dest.origin_pr, 407);
  });
});

test('migrate errors when --from is missing or does not exist', async () => {
  const home = tmpDir();
  await withHome(home, async () => {
    assert.equal(await quiet(() => migrate({ dir: tmpDir() })), 1);
    assert.equal(await quiet(() => migrate({ from: '/no/such/store', dir: tmpDir() })), 1);
  });
});
