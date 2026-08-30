#!/usr/bin/env node
// Sync every skill from its single source into the Claude plugin.
// Source of truth: packages/cli/skill/<skill>
// Vendored copy:   plugins/lorekit-claude/skills/<skill>
//
//   node scripts/codegen/sync-plugin-skill.mjs          copy source → plugin (all skills)
//   node scripts/codegen/sync-plugin-skill.mjs --check  exit 1 if they differ (CI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = path.join(ROOT, 'packages/cli/skill');
const DEST_ROOT = path.join(ROOT, 'plugins/lorekit-claude/skills');

function walk(dir, base = dir, acc = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.set(path.relative(base, p), fs.readFileSync(p, 'utf8'));
  }
  return acc;
}

function listDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

const check = process.argv.includes('--check');
const srcSkills = listDirs(SRC_ROOT);
const destSkills = listDirs(DEST_ROOT);

if (check) {
  const diffs = [];
  for (const skill of srcSkills) {
    const src = walk(path.join(SRC_ROOT, skill));
    let dest;
    try {
      dest = walk(path.join(DEST_ROOT, skill));
    } catch {
      dest = new Map();
    }
    for (const [rel, content] of src) {
      if (dest.get(rel) !== content) diffs.push(`${skill}/${rel}`);
    }
    for (const rel of dest.keys()) {
      if (!src.has(rel)) diffs.push(`${skill}/${rel} (stale)`);
    }
  }
  // A whole skill vendored in the plugin but no longer in source is stale.
  for (const skill of destSkills) {
    if (!srcSkills.includes(skill)) diffs.push(`${skill}/ (stale skill)`);
  }
  if (diffs.length) {
    console.error('Plugin skills out of sync with source:\n  ' + diffs.join('\n  '));
    console.error('Run: node scripts/codegen/sync-plugin-skill.mjs');
    process.exit(1);
  }
  console.log(`Plugin skills are in sync (${srcSkills.length}).`);
  process.exit(0);
}

// Remove any vendored skill that no longer has a source, then mirror each source
// skill fresh.
for (const skill of destSkills) {
  if (!srcSkills.includes(skill)) {
    fs.rmSync(path.join(DEST_ROOT, skill), { recursive: true, force: true });
  }
}
let total = 0;
for (const skill of srcSkills) {
  const src = walk(path.join(SRC_ROOT, skill));
  const dest = path.join(DEST_ROOT, skill);
  fs.rmSync(dest, { recursive: true, force: true });
  for (const [rel, content] of src) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content);
  }
  total += src.size;
}
console.log(`Synced ${total} file(s) across ${srcSkills.length} skill(s) → ${path.relative(ROOT, DEST_ROOT)}`);
