#!/usr/bin/env node
'use strict';
// Move e2e specs between this suite and /ui-verify. Usage: specs/README.md.
//
//   node scripts/ui-verify.cjs import --pr <number|url> [--out <file>] [--force]
//   node scripts/ui-verify.cjs import --file <path>    [--out <file>] [--force]
//   node scripts/ui-verify.cjs import --routes <dir>   [--out <file>] [--force]
//   node scripts/ui-verify.cjs export <spec.md> [<spec.md> …]
//
// Every import is validated with the suite's own parser before it is reported
// ready; a draft with TODO lines is written, named as a draft, and fails
// `nx test web-e2e` until it is finished — it can never pass by accident.

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const {
  SpecError,
  extractUiVerifyBlock,
  intentToDraft,
  parseSpecFile,
  routesToSpecs,
  specsToUiVerifyBlock,
} = require('../src/spec/grammar.cjs');

const PKG = path.join(__dirname, '..');

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      'usage:',
      '  ui-verify.cjs import --pr <number|url> [--out <file>] [--force]',
      '  ui-verify.cjs import --file <path>    [--out <file>] [--force]',
      '  ui-verify.cjs import --routes <dir>   [--out <file>] [--force]',
      '  ui-verify.cjs export <spec.md> [<spec.md> …]',
    ].join('\n'),
  );
  process.exit(2);
}

function flag(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? usage(`${name} needs a value`);
}

/** A spec file body from ui-verify block content (or a whole spec file). */
function fromBlockOrFile(text, origin) {
  const block = extractUiVerifyBlock(text);
  const content = block ? block.content : text;
  const isIntent = block ? block.version === 'v2' : /^Format:\s*intent\s*$/m.test(content);
  if (isIntent) {
    const { text: draft, todos } = intentToDraft(content);
    return { body: draft, note: `intent spec → draft with ${todos} TODO line(s) to finish` };
  }
  // Grammar: keep everything from the first spec heading, drop the header.
  const at = content.search(/^## Spec /m);
  if (at === -1) throw new Error(`${origin}: no \`## Spec\` block found`);
  return { body: content.slice(at).trim() + '\n', note: 'grammar spec → imported verbatim' };
}

function runImport(args) {
  const pr = flag(args, '--pr');
  const file = flag(args, '--file');
  const routes = flag(args, '--routes');
  if ([pr, file, routes].filter(Boolean).length !== 1) usage('import takes exactly one of --pr, --file, --routes');

  let body;
  let notes = [];
  let defaultName;
  if (pr) {
    const number = /(\d+)\/?$/.exec(pr)?.[1] ?? usage(`not a PR number or URL: ${pr}`);
    const prBody = execFileSync('gh', ['pr', 'view', pr, '--json', 'body', '-q', '.body'], { encoding: 'utf8' });
    if (!extractUiVerifyBlock(prBody)) throw new Error(`PR ${pr} has no ui-verify block`);
    ({ body, note: notes[0] } = fromBlockOrFile(prBody, `PR ${pr}`));
    defaultName = `pr-${number}.md`;
  } else if (file) {
    ({ body, note: notes[0] } = fromBlockOrFile(readFileSync(file, 'utf8'), file));
    defaultName = `${path.basename(file, path.extname(file))}.md`;
  } else {
    const files = readdirSync(routes)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((name) => ({ name, text: readFileSync(path.join(routes, name), 'utf8') }));
    if (files.length === 0) throw new Error(`${routes}: no route files (*.md)`);
    const out = routesToSpecs(files);
    body = out.text;
    notes = [`${files.length} compiled route(s) → imported`, ...out.warnings];
    defaultName = 'ui-verify-routes.md';
  }

  const out = path.resolve(flag(args, '--out') ?? path.join(PKG, 'specs', defaultName));
  if (existsSync(out) && !args.includes('--force')) throw new Error(`${out} exists — pass --force to overwrite`);
  const text = `# Specs: imported from ui-verify\n\nTarget: local\n\n${body}`;
  writeFileSync(out, text);

  for (const n of notes) console.log(`• ${n}`);
  try {
    const specs = parseSpecFile(text, path.relative(PKG, out));
    console.log(`✓ ${specs.length} spec(s) ready → ${path.relative(process.cwd(), out)}`);
  } catch (err) {
    if (!(err instanceof SpecError)) throw err;
    console.log(`! draft written → ${path.relative(process.cwd(), out)}`);
    console.log(`  finish it before it can run: ${err.message}`);
  }
}

function runExport(args) {
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) usage('export needs at least one spec file');
  const specs = files.flatMap((f) => parseSpecFile(readFileSync(f, 'utf8'), f));
  process.stdout.write(`${specsToUiVerifyBlock(specs)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'import') runImport(rest);
  else if (command === 'export') runExport(rest);
  else usage(command ? `unknown command "${command}"` : undefined);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
