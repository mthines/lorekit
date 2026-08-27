// Shell completion: the `completion` command, the generated zsh/fish scripts,
// and the install/uninstall wiring helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completion } from '../src/commands/completion.mjs';
import {
  COMPLETION_SHELLS,
  completionSpec,
  renderCompletion,
  detectShell,
  completionTargets,
  upsertGuardedBlock,
  removeGuardedBlock,
  installCompletion,
  removeCompletion,
} from '../src/shared/completions.mjs';
import { requestedCompletionMode, INVALID_COMPLETION_MODE, install } from '../src/commands/install.mjs';
import { COMMANDS } from '../src/commands.mjs';
import { resolveStores } from '../src/shared/stores.mjs';
import { setWriters } from '../src/shared/util.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Capture everything a handler writes via log()/err() by swapping the util
// writers — cleaner than hijacking process.stdout and it never swallows the
// node:test runner's own output.
async function capture(fn) {
  let out = '';
  let errOut = '';
  const restore = setWriters({ out: (s) => { out += s; }, err: (s) => { errOut += s; } });
  try {
    await fn();
  } finally {
    restore();
  }
  return { out, errOut };
}

// The KNOWN_FLAGS the CLI parser accepts, read from bin so the completion spec
// is checked against the SAME list dispatch enforces — a completion that
// advertised a flag the parser rejects would be a lie.
function knownFlagsFromBin() {
  const bin = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
  const src = fs.readFileSync(bin, 'utf8');
  const block = src.match(/const KNOWN_FLAGS = \[([\s\S]*?)\];/);
  assert.ok(block, 'KNOWN_FLAGS array not found in bin/lorekit.mjs');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

describe('completion spec', () => {
  test('covers every registry command except the pure machine ones', () => {
    // The spec is the source of truth for what completion offers; the registry
    // is the source of truth for what EXISTS. `hook` / `mcp` are "not run by
    // hand" so they are deliberately absent. Everything else must be present, or
    // a new command ships with no completion and nobody notices.
    const specNames = completionSpec().map((c) => c.name).sort();
    const expected = COMMANDS.map((c) => c.name)
      .filter((n) => n !== 'hook' && n !== 'mcp')
      .sort();
    assert.deepEqual(specNames, expected);
  });

  test('references only flags the parser knows', () => {
    const known = knownFlagsFromBin();
    for (const cmd of completionSpec()) {
      for (const flag of cmd.flags) {
        assert.ok(known.has(flag.name), `command ${cmd.name} completes unknown flag --${flag.name}`);
      }
    }
  });

  test('carries the registry aliases so `lorekit l<TAB>` finds ls', () => {
    const byName = new Map(completionSpec().map((c) => [c.name, c]));
    assert.deepEqual(byName.get('list').aliases, ['ls']);
    assert.deepEqual(byName.get('delete').aliases, ['rm']);
  });
});

describe('script rendering', () => {
  test('zsh script is well-formed and wires the dynamic helpers', () => {
    const script = renderCompletion('zsh');
    assert.match(script, /^#compdef lorekit/);
    assert.match(script, /compdef _lorekit lorekit\s*$/);
    // A command, a per-command flag, the dynamic callbacks.
    assert.match(script, /'install:/);
    assert.match(script, /--scope\[Restrict to \/ name a scope\]:scope:_lorekit_scopes/);
    assert.match(script, /lorekit completion --complete scope/);
    assert.match(script, /lorekit completion --complete key/);
    // The literal `${(f)…}` must survive into the script, not be eaten by JS.
    assert.match(script, /\$\{\(f\)/);
  });

  test('fish script guards flags per subcommand and wires dynamic values', () => {
    const script = renderCompletion('fish');
    assert.match(script, /complete -c lorekit -n __fish_use_subcommand -a install/);
    assert.match(script, /__fish_seen_subcommand_from list ls/);
    assert.match(script, /-a '\(lorekit completion --complete scope\)'/);
    assert.match(script, /-a '\(lorekit completion --complete key\)'/);
  });

  test('an unsupported shell throws rather than emitting an empty file', () => {
    assert.throws(() => renderCompletion('bash'), /Unsupported shell/);
  });
});

describe('shell detection', () => {
  test('reads a supported shell from $SHELL, else null', () => {
    assert.equal(detectShell({ SHELL: '/bin/zsh' }), 'zsh');
    assert.equal(detectShell({ SHELL: '/usr/local/bin/fish' }), 'fish');
    assert.equal(detectShell({ SHELL: '/bin/bash' }), null);
    assert.equal(detectShell({}), null);
  });
});

describe('guarded ~/.zshrc block', () => {
  test('appends once and replaces in place — never duplicates', () => {
    const block = '# >>> lorekit completions >>>\nfpath=("/a" $fpath)\n# <<< lorekit completions <<<';
    const first = upsertGuardedBlock('export FOO=bar\n', block);
    assert.match(first.text, /export FOO=bar/);
    assert.match(first.text, /lorekit completions/);
    assert.equal(first.changed, true);

    // Re-applying the same block is a no-op.
    const again = upsertGuardedBlock(first.text, block);
    assert.equal(again.changed, false);
    assert.equal((again.text.match(/>>> lorekit completions >>>/g) || []).length, 1);

    // A changed block replaces the old one in place, still once.
    const updated = '# >>> lorekit completions >>>\nfpath=("/b" $fpath)\n# <<< lorekit completions <<<';
    const swapped = upsertGuardedBlock(again.text, updated);
    assert.match(swapped.text, /fpath=\("\/b"/);
    assert.equal((swapped.text.match(/>>> lorekit completions >>>/g) || []).length, 1);
  });

  test('removeGuardedBlock strips the block and keeps the rest', () => {
    const block = '# >>> lorekit completions >>>\nx\n# <<< lorekit completions <<<';
    const withBlock = upsertGuardedBlock('export FOO=bar\n', block).text;
    const removed = removeGuardedBlock(withBlock);
    assert.equal(removed.changed, true);
    assert.doesNotMatch(removed.text, /lorekit completions/);
    assert.match(removed.text, /export FOO=bar/);
    // Removing from text without a block is a no-op.
    assert.equal(removeGuardedBlock('export FOO=bar\n').changed, false);
  });
});

describe('install / remove on disk', () => {
  test('fish writes an auto-loaded file, no rc edit', () => {
    const home = tmp('lk-fish-');
    const res = installCompletion('fish', { home });
    assert.equal(res.autoloaded, true);
    assert.equal(res.rcUpdated, false);
    assert.equal(res.file, completionTargets('fish', home).file);
    assert.ok(fs.existsSync(res.file));
    assert.match(fs.readFileSync(res.file, 'utf8'), /__fish_use_subcommand/);

    const gone = removeCompletion('fish', { home });
    assert.equal(gone.removed, true);
    assert.ok(!fs.existsSync(res.file));
  });

  test('zsh writes the script and a guarded ~/.zshrc block, idempotently', () => {
    const home = tmp('lk-zsh-');
    fs.writeFileSync(path.join(home, '.zshrc'), 'export FOO=bar\n');

    const res = installCompletion('zsh', { home });
    assert.equal(res.autoloaded, false);
    assert.equal(res.rcUpdated, true);
    assert.ok(fs.existsSync(res.file));
    const rc1 = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert.match(rc1, /export FOO=bar/);
    assert.match(rc1, /fpath=/);

    // Re-install: the block is not duplicated and the rc is unchanged.
    const res2 = installCompletion('zsh', { home });
    assert.equal(res2.rcUpdated, false);
    const rc2 = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert.equal((rc2.match(/>>> lorekit completions >>>/g) || []).length, 1);

    const gone = removeCompletion('zsh', { home });
    assert.equal(gone.removed, true);
    assert.ok(!fs.existsSync(res.file));
    const rc3 = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert.doesNotMatch(rc3, /lorekit completions/);
    assert.match(rc3, /export FOO=bar/);
  });
});

describe('completion command', () => {
  test('prints the script for a supported shell', async () => {
    const { out } = await capture(() => completion({ _: ['completion', 'zsh'] }));
    assert.match(out, /#compdef lorekit/);
  });

  test('errors on a missing or unsupported shell', async () => {
    const miss = await capture(async () => {
      assert.equal(await completion({ _: ['completion'] }), 1);
    });
    assert.match(miss.errOut, /Missing shell/);

    const bad = await capture(async () => {
      assert.equal(await completion({ _: ['completion', 'bash'] }), 1);
    });
    assert.match(bad.errOut, /Unsupported shell/);
  });

  test('--complete scope and key list the local store, offline', async () => {
    const home = tmp('lk-dyn-');
    const root = tmp('lk-dynroot-');
    const env = { ...process.env, LOREKIT_HOME: home, LOREKIT_STORE: path.join(root, '.lorekit') };
    const { local } = resolveStores(root, { env });
    await local.write({ scope: 'global', key: 'alpha', value: 'a' });
    await local.write({ scope: 'global', key: 'beta', value: 'b' });

    const prevHome = process.env.LOREKIT_HOME;
    const prevStore = process.env.LOREKIT_STORE;
    process.env.LOREKIT_HOME = env.LOREKIT_HOME;
    process.env.LOREKIT_STORE = env.LOREKIT_STORE;
    try {
      const scopes = await capture(() => completion({ _: ['completion'], complete: 'scope', dir: root }));
      assert.match(scopes.out, /^global$/m);

      const keys = await capture(() => completion({ _: ['completion'], complete: 'key', dir: root }));
      assert.match(keys.out, /global::alpha/);
      assert.match(keys.out, /global::beta/);
    } finally {
      if (prevHome === undefined) delete process.env.LOREKIT_HOME; else process.env.LOREKIT_HOME = prevHome;
      if (prevStore === undefined) delete process.env.LOREKIT_STORE; else process.env.LOREKIT_STORE = prevStore;
    }
  });

  test('--complete never throws on an unreadable store', async () => {
    const res = await capture(async () => {
      assert.equal(await completion({ _: ['completion'], complete: 'scope', dir: '/nonexistent/xyz' }), 0);
    });
    assert.equal(res.errOut, '');
  });
});

describe('install --completions flag', () => {
  test('requestedCompletionMode: value, absent, and bare-flag sentinel', () => {
    assert.equal(requestedCompletionMode({ completions: 'zsh' }), 'zsh');
    assert.equal(requestedCompletionMode({ completions: 'AUTO' }), 'auto');
    assert.equal(requestedCompletionMode({}), null);
    assert.equal(requestedCompletionMode({ completions: true }), INVALID_COMPLETION_MODE);
    // A bare `--completions=` is a usage error, not an absent flag — same
    // discipline as `--hooks=`.
    assert.equal(requestedCompletionMode({ completions: '' }), INVALID_COMPLETION_MODE);
  });

  test('a bogus mode is rejected before anything is written', async () => {
    const root = tmp('lk-badcomp-');
    const res = await capture(async () => {
      assert.equal(await install({ dir: root, yes: true, project: true, completions: 'nushell' }), 1);
    });
    assert.match(res.errOut, /Unknown --completions mode/);
    // Nothing scaffolded — the validation fired first.
    assert.ok(!fs.existsSync(path.join(root, '.claude')));
  });
});
