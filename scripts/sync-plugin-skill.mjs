#!/usr/bin/env node
// Sync the lorekit-memory skill from its single source into the Claude plugin.
// Source of truth: packages/cli/skill/lorekit-memory
// Vendored copy:   plugins/lorekit-claude/skills/lorekit-memory
//
//   node scripts/sync-plugin-skill.mjs          copy source → plugin
//   node scripts/sync-plugin-skill.mjs --check  exit 1 if they differ (CI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'packages/cli/skill/lorekit-memory');
const DEST = path.join(ROOT, 'plugins/lorekit-claude/skills/lorekit-memory');

function walk(dir, base = dir, acc = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.set(path.relative(base, p), fs.readFileSync(p, 'utf8'));
  }
  return acc;
}

const check = process.argv.includes('--check');
const src = walk(SRC);

if (check) {
  let dest;
  try {
    dest = walk(DEST);
  } catch {
    dest = new Map();
  }
  const diffs = [];
  for (const [rel, content] of src) {
    if (dest.get(rel) !== content) diffs.push(rel);
  }
  for (const rel of dest.keys()) {
    if (!src.has(rel)) diffs.push(`${rel} (stale)`);
  }
  if (diffs.length) {
    console.error('Plugin skill out of sync with source:\n  ' + diffs.join('\n  '));
    console.error('Run: node scripts/sync-plugin-skill.mjs');
    process.exit(1);
  }
  console.log('Plugin skill is in sync.');
  process.exit(0);
}

fs.rmSync(DEST, { recursive: true, force: true });
for (const [rel, content] of src) {
  const to = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, content);
}
console.log(`Synced ${src.size} file(s) → ${path.relative(ROOT, DEST)}`);
