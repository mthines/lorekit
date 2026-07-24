// `lorekit migrate` — dry-run/apply/idempotency and scope routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../src/migrate.mjs';
import { createLocalStore } from '../src/store/local.mjs';

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

test('migrate errors when --from is missing or does not exist', async () => {
  const home = tmpDir();
  await withHome(home, async () => {
    assert.equal(await quiet(() => migrate({ dir: tmpDir() })), 1);
    assert.equal(await quiet(() => migrate({ from: '/no/such/store', dir: tmpDir() })), 1);
  });
});
