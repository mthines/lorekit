'use strict';
// The e2e spec grammar: aw-tester's WHEN/THEN format (the `<!-- ui-verify:v1 -->`
// body), parsed deterministically so Playwright can run it in CI with no LLM.
//
// One source of truth for three consumers:
//   • src/specs.e2e.ts      — turns every `## Spec` block in specs/*.md into a test
//   • src/specs.test.ts     — parses every file and guards page coverage (vitest, `check`)
//   • scripts/ui-verify.cjs — imports ui-verify blocks / compiled routes, exports specs
//
// The grammar is aw-tester's (agent-skills: autonomous-workflow/templates/
// specs.md.template). This file implements the subset that can be checked
// without judgment, and REFUSES the rest by name rather than skipping it — a
// line nobody executes must never read as a passing check:
//
//   semantic:        needs an LLM judge (jev-assert)       → refused
//   continues-from:  tests run isolated and in parallel    → refused
//   Format: intent   needs aw-tester to explore the route  → refused (import it)
//
// Zero dependencies and CommonJS on purpose: Playwright (which transpiles the
// suite to CJS), vitest, and a plain `node` script all load it on Node ≥ 18.

/**
 * @typedef {object} Locator
 * @property {string} [role]
 * @property {string|RegExp} [name]
 * @property {boolean} [exact]
 * @property {string|RegExp} [label]
 * @property {string|RegExp} [placeholder]
 * @property {string|RegExp} [text]
 * @property {string} [testid]
 *
 * @typedef {{ kind: 'load' }
 *   | { kind: 'click' | 'check' | 'hover', locator: Locator }
 *   | { kind: 'fill' | 'press', locator: Locator, value: string }} Action
 *
 * @typedef {{ kind: 'visible' | 'hidden', locator: Locator }
 *   | { kind: 'attribute', locator: Locator, attribute: string, value: string }
 *   | { kind: 'network', method: string, path: string, status: number }} Assertion
 *
 * @typedef {{ kind: 'step', action: Action, source: string, line: number,
 *             assertions: { assertion: Assertion, source: string, line: number }[] }
 *   | { kind: 'capture', label: string, fullPage: boolean, source: string, line: number }} FlowItem
 *
 * @typedef {object} Spec
 * @property {string} id          the token after `## Spec` (`1`, `login-form`, …)
 * @property {string} title
 * @property {string} file
 * @property {number} line        1-based line of the `## Spec` heading
 * @property {string} url
 * @property {string|null} persist
 * @property {string[]} preconditions
 * @property {boolean} signedIn   a precondition says the user is signed / logged in
 * @property {Partial<Record<'local'|'preview'|'production', string>>} skipOn
 * @property {FlowItem[]} flow
 * @property {string} block       the spec's source text, heading included
 */

class SpecError extends Error {
  /** @param {string} file @param {number} line @param {string} message */
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.name = 'SpecError';
    this.file = file;
    this.line = line;
  }
}

const SPEC_HEADING = /^## Spec ([\w-]+):\s*(.+?)\s*$/;

const ACTIONS_HELP =
  'supported actions: `page loads`, `{…} is clicked`, `{…} is filled with "…"`, ' +
  '`{…} is pressed with "Enter"`, `{…} is checked`, `{…} is hovered`';
const ASSERTIONS_HELP =
  'supported assertions: `{…} is visible`, `{…} is not visible`, `{…} has <attribute>: <value>`, ' +
  '`network: METHOD /path returned NNN`';

// ── locators ─────────────────────────────────────────────────────────────────

const LOCATOR_KEYS = new Set(['role', 'name', 'exact', 'label', 'placeholder', 'text', 'testid']);
const PRIMARY_KEYS = ['role', 'label', 'placeholder', 'text', 'testid'];

/**
 * Parse a `{key: value, …}` locator at the start of `input`. Values are
 * double-quoted strings, `/regex/flags`, or `true`/`false`. Returns the locator
 * and the unparsed rest of the string.
 *
 * @param {string} input
 * @returns {{ locator: Locator, rest: string }}
 */
function parseLocator(input) {
  const s = input.trimStart();
  if (s[0] !== '{') {
    throw new Error(
      `expected a locator like {role: "button", name: "Save"} — CSS selectors, nth-child and XPath are never valid (got: ${s.slice(0, 40)})`,
    );
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  let i = 1;
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  for (;;) {
    skipWs();
    if (s[i] === '}') {
      i++;
      break;
    }
    const keyMatch = /^[A-Za-z]+/.exec(s.slice(i));
    if (!keyMatch) throw new Error(`malformed locator near: ${s.slice(i, i + 30)}`);
    const key = keyMatch[0];
    if (!LOCATOR_KEYS.has(key)) {
      throw new Error(`unknown locator key "${key}" — use one of ${[...LOCATOR_KEYS].join(', ')}`);
    }
    i += key.length;
    skipWs();
    if (s[i] !== ':') throw new Error(`expected ":" after locator key "${key}"`);
    i++;
    skipWs();
    let value;
    if (s[i] === '"') {
      let str = '';
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        str += s[i++];
      }
      if (s[i] !== '"') throw new Error(`unterminated string in locator key "${key}"`);
      i++;
      value = str;
    } else if (s[i] === '/') {
      let src = '';
      i++;
      while (i < s.length && s[i] !== '/') {
        if (s[i] === '\\' && i + 1 < s.length) src += s[i++];
        src += s[i++];
      }
      if (s[i] !== '/') throw new Error(`unterminated regex in locator key "${key}"`);
      i++;
      const flags = /^[a-z]*/.exec(s.slice(i))[0];
      i += flags.length;
      value = new RegExp(src, flags);
    } else if (s.startsWith('true', i) || s.startsWith('false', i)) {
      value = s.startsWith('true', i);
      i += value ? 4 : 5;
    } else {
      throw new Error(`locator value for "${key}" must be "a string", /a regex/ or true/false`);
    }
    out[key] = value;
    skipWs();
    if (s[i] === ',') {
      i++;
      continue;
    }
    if (s[i] === '}') {
      i++;
      break;
    }
    throw new Error(`expected "," or "}" in locator near: ${s.slice(i, i + 30)}`);
  }
  const primaries = PRIMARY_KEYS.filter((k) => k in out);
  if (primaries.length !== 1) {
    throw new Error(`a locator needs exactly one of ${PRIMARY_KEYS.join(' / ')} (got ${primaries.join(', ') || 'none'})`);
  }
  if ('name' in out && !('role' in out)) throw new Error('"name" only goes with "role"');
  return { locator: /** @type {Locator} */ (out), rest: s.slice(i).trim() };
}

// ── actions and assertions ───────────────────────────────────────────────────

/** @param {string} text @returns {Action} */
function parseAction(text) {
  if (/^page loads$/i.test(text)) return { kind: 'load' };
  const { locator, rest } = parseLocator(text);
  if (rest === 'is clicked') return { kind: 'click', locator };
  if (rest === 'is checked') return { kind: 'check', locator };
  if (rest === 'is hovered') return { kind: 'hover', locator };
  const fill = /^is filled with "((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (fill) return { kind: 'fill', locator, value: fill[1].replace(/\\(.)/g, '$1') };
  const press = /^is pressed with "([^"]+)"$/.exec(rest);
  if (press) return { kind: 'press', locator, value: press[1] };
  throw new Error(`unsupported action "${rest}" — ${ACTIONS_HELP}`);
}

/** @param {string} text @returns {Assertion} */
function parseAssertion(text) {
  const network = /^network:\s*([A-Z]+)\s+(\/\S*)\s+returned\s+(\d{3})$/.exec(text);
  if (network) {
    if (/[{}]/.test(network[2])) throw new Error(`replace the {placeholder} in ${network[2]} with a real path`);
    return { kind: 'network', method: network[1], path: network[2], status: Number(network[3]) };
  }
  if (/^network:/.test(text)) throw new Error('network assertions read exactly `network: METHOD /path returned NNN`');
  if (/^semantic:/.test(text)) {
    throw new Error(
      '`semantic:` needs an LLM judge and cannot run in CI — assert what the user sees with a {locator} instead',
    );
  }
  const { locator, rest } = parseLocator(text);
  if (rest === 'is visible' || rest === 'is visible on the page') return { kind: 'visible', locator };
  if (rest === 'is not visible') return { kind: 'hidden', locator };
  if (/^has text\b/.test(rest)) {
    throw new Error('`has text` is not an attribute — assert text with `{text: "…"} is visible`');
  }
  const attr = /^has ([\w-]+):\s*"?(.*?)"?$/.exec(rest);
  if (attr) return { kind: 'attribute', locator, attribute: attr[1], value: attr[2] };
  throw new Error(`unsupported assertion "${rest}" — ${ASSERTIONS_HELP}`);
}

// ── preconditions ────────────────────────────────────────────────────────────

/**
 * Preconditions are free text in the grammar ("User is logged in as admin
 * (handled by aw-target auth)"). Two phrasings change how the suite runs it;
 * everything else is documentation.
 *
 *   "User is signed in …" / "… logged in …"  → runs in the signed-in project
 *   "Not on production: <why>"               → skipped on that target (also preview / local)
 *
 * @param {string[]} items
 */
function interpretPreconditions(items) {
  let signedIn = false;
  /** @type {Spec['skipOn']} */
  const skipOn = {};
  for (const item of items) {
    const skip = /^not on (production|preview|local)\b[\s:—–-]*(.*)$/i.exec(item);
    if (skip) {
      const target = /** @type {'production'|'preview'|'local'} */ (skip[1].toLowerCase());
      skipOn[target] = skip[2] || `the spec says it does not run on ${target}`;
      continue;
    }
    if (/\b(signed|logged)[ -]in\b/i.test(item) && !/\bnot (signed|logged)[ -]in\b/i.test(item)) signedIn = true;
  }
  return { signedIn, skipOn };
}

// ── files ────────────────────────────────────────────────────────────────────

/**
 * Parse one spec file. Throws a SpecError naming `file:line` on the first line
 * it cannot execute exactly as written.
 *
 * @param {string} text
 * @param {string} file  shown in errors and test titles
 * @returns {Spec[]}
 */
function parseSpecFile(text, file) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstSpec = lines.findIndex((l) => SPEC_HEADING.test(l));
  const header = firstSpec === -1 ? lines : lines.slice(0, firstSpec);
  const intentAt = header.findIndex((l) => /^Format:\s*intent\s*$/.test(l.trim()));
  if (intentAt !== -1) {
    throw new SpecError(
      file,
      intentAt + 1,
      'this is a ui-verify intent spec (Format: intent), which needs aw-tester to explore the route. ' +
        'Convert it: `pnpm --filter @lorekit/web-e2e spec:import --file <it>` (see specs/README.md)',
    );
  }
  if (firstSpec === -1) return [];

  /** @type {Spec[]} */
  const specs = [];
  /** @type {Spec | null} */
  let spec = null;
  /** @type {'none'|'preconditions'|'flow'} */
  let section = 'none';
  /** @type {Extract<FlowItem, {kind: 'step'}> | null} */
  let step = null;
  let blockStart = 0;

  const finish = (endLine) => {
    if (!spec) return;
    spec.block = lines.slice(blockStart, endLine).join('\n').replace(/\s+$/, '');
    if (!spec.url) throw new SpecError(file, spec.line, `Spec ${spec.id} has no \`url:\``);
    if (spec.flow.length === 0) throw new SpecError(file, spec.line, `Spec ${spec.id} has no \`flow:\` steps`);
    const assertions = spec.flow.reduce((n, f) => n + (f.kind === 'step' ? f.assertions.length : 0), 0);
    if (assertions === 0) throw new SpecError(file, spec.line, `Spec ${spec.id} asserts nothing — add a THEN`);
    Object.assign(spec, interpretPreconditions(spec.preconditions));
    specs.push(spec);
  };

  for (let idx = firstSpec; idx < lines.length; idx++) {
    const raw = lines[idx];
    const lineNo = idx + 1;
    const line = raw.trim();
    const fail = (msg) => {
      throw new SpecError(file, lineNo, msg);
    };

    const heading = SPEC_HEADING.exec(raw);
    if (heading) {
      finish(idx);
      blockStart = idx;
      spec = {
        id: heading[1],
        title: heading[2],
        file,
        line: lineNo,
        url: '',
        persist: null,
        preconditions: [],
        signedIn: false,
        skipOn: {},
        flow: [],
        block: '',
      };
      section = 'none';
      step = null;
      continue;
    }
    if (line === '') continue;
    if (/^#{2,} /.test(raw)) fail('only `## Spec <id>: <title>` headings are allowed after the first spec');
    if (line.startsWith('#')) {
      if (/^#\s*TODO/i.test(line)) fail(`unfinished imported step — replace it with WHEN/THEN lines: ${line}`);
      continue; // a comment (`# route-for:`, `# hint:` …)
    }
    if (!spec) fail('unexpected line before the first `## Spec` heading');
    const s = /** @type {Spec} */ (spec);

    let m;
    if ((m = /^url:\s*(\S+)$/.exec(line))) {
      if (!m[1].startsWith('/')) fail(`url must be a path starting with "/" (got ${m[1]})`);
      if (/[{}]/.test(m[1])) fail(`replace the {placeholder} in ${m[1]} with a real path — the e2e suite has no fixtures`);
      s.url = m[1];
      section = 'none';
    } else if ((m = /^persist:\s*(\S+)$/.exec(line))) {
      if (!['critical-path', 'verify-only'].includes(m[1])) fail('persist is critical-path or verify-only');
      s.persist = m[1];
      section = 'none';
    } else if (/^continues-from:/.test(line)) {
      fail('continues-from is not supported: specs run isolated and in parallel — fold the steps into one spec');
    } else if (line === 'preconditions:') {
      section = 'preconditions';
    } else if (line === 'flow:') {
      section = 'flow';
    } else if (section === 'preconditions' && (m = /^-\s+(.+)$/.exec(line))) {
      s.preconditions.push(m[1]);
    } else if (section === 'flow' && (m = /^-\s+WHEN\s+(.+)$/.exec(line))) {
      try {
        step = { kind: 'step', action: parseAction(m[1]), source: `WHEN ${m[1]}`, line: lineNo, assertions: [] };
      } catch (err) {
        fail(/** @type {Error} */ (err).message);
      }
      s.flow.push(/** @type {FlowItem} */ (step));
    } else if (section === 'flow' && (m = /^-\s+CAPTURE\s+"([^"]+)"(\s+fullPage)?$/.exec(line))) {
      s.flow.push({ kind: 'capture', label: m[1], fullPage: Boolean(m[2]), source: line.slice(2), line: lineNo });
      step = null;
    } else if (section === 'flow' && (m = /^(THEN|AND)\s+(.+)$/.exec(line))) {
      if (!step) fail(`${m[1]} must follow a WHEN step`);
      try {
        /** @type {NonNullable<typeof step>} */ (step).assertions.push({
          assertion: parseAssertion(m[2]),
          source: `${m[1]} ${m[2]}`,
          line: lineNo,
        });
      } catch (err) {
        fail(/** @type {Error} */ (err).message);
      }
    } else if (section === 'flow' && /^-\s+(THEN|AND)\b/.test(line)) {
      fail('a flow item starts with WHEN; put THEN/AND on the lines under it');
    } else {
      fail(`unrecognized line: ${line}`);
    }
  }
  finish(lines.length);
  return specs;
}

// ── routes ───────────────────────────────────────────────────────────────────

/**
 * An app-router route (`/docs/[slug]`, `/learn/[[...slug]]`) as a RegExp that
 * matches the concrete paths it serves.
 *
 * @param {string} route
 */
function routeToRegExp(route) {
  if (route === '/') return /^\/$/;
  const body = route
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (/^\[\[\.\.\..+\]\]$/.test(seg)) return '(?:/.*)?';
      if (/^\[\.\.\..+\]$/.test(seg)) return '/.+';
      if (/^\[.+\]$/.test(seg)) return '/[^/]+';
      return `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return new RegExp(`^${body}/?$`);
}

/** The path part of a spec url (no query, no hash). @param {string} url */
const urlPath = (url) => url.split(/[?#]/)[0];

// ── ui-verify interop ────────────────────────────────────────────────────────

const BLOCKS = [
  { version: 'v2', open: '<!-- ui-verify:v2 -->', close: '<!-- /ui-verify:v2 -->' },
  { version: 'v1', open: '<!-- ui-verify:v1 -->', close: '<!-- /ui-verify:v1 -->' },
  { version: 'legacy', open: '<!-- preview-spec:v1 -->', close: '<!-- /preview-spec:v1 -->' },
];

/**
 * The ui-verify block in a PR body (or any Markdown), with its collapsed
 * `<details>` wrapper removed. Null when there is none.
 *
 * @param {string} body
 * @returns {{ version: 'v2'|'v1'|'legacy', content: string } | null}
 */
function extractUiVerifyBlock(body) {
  for (const b of BLOCKS) {
    const start = body.indexOf(b.open);
    if (start === -1) continue;
    const end = body.indexOf(b.close, start);
    if (end === -1) continue;
    const content = body
      .slice(start + b.open.length, end)
      .split('\n')
      .filter((l) => !/^\s*<\/?details>\s*$/.test(l) && !/^\s*<summary>.*<\/summary>\s*$/.test(l))
      .join('\n')
      .trim();
    return { version: /** @type {any} */ (b.version), content };
  }
  return null;
}

/**
 * Translate a ui-verify INTENT spec (v2) into a grammar draft. What maps
 * mechanically is translated (`**Start:**` → `url:`, preconditions, network
 * outcomes); every step and every other outcome becomes a `# TODO` line, which
 * the parser refuses — so a half-converted draft fails the PR until a person
 * writes its WHEN/THEN lines. Never guesses a locator.
 *
 * @param {string} content  the block body (or a whole intent spec file)
 * @returns {{ text: string, todos: number }}
 */
function intentToDraft(content) {
  const out = [];
  let todos = 0;
  const blocks = content.split(/^(?=## Spec [\w-]+:)/m).filter((b) => SPEC_HEADING.test(b.split('\n')[0]));
  for (const block of blocks) {
    const [headingLine, ...rest] = block.split('\n');
    const field = (name) => {
      const at = rest.findIndex((l) => l.startsWith(`**${name}:**`));
      if (at === -1) return null;
      const inline = rest[at].slice(`**${name}:**`.length).trim();
      const items = [];
      for (let i = at + 1; i < rest.length && !/^\*\*[^*]+:\*\*/.test(rest[i]); i++) {
        const m = /^\s*(?:\d+\.|-)\s+(.+)$/.exec(rest[i]);
        if (m) items.push(m[1].trim());
      }
      return { inline, items };
    };
    const start = field('Start')?.inline || '/';
    const changed = field('Changed')?.inline;
    out.push(headingLine.trim(), 'persist: critical-path', `url: ${start}`);
    if (changed) out.push(`# changed: ${changed}`);
    const pre = field('Preconditions')?.items ?? [];
    if (pre.length) out.push('preconditions:', ...pre.map((p) => `  - ${p}`));
    for (const h of field('Hints')?.items ?? []) out.push(`# hint: ${h}`);
    out.push('flow:', '  - WHEN page loads');
    for (const [n, stepText] of (field('Steps')?.items ?? []).entries()) {
      out.push(`# TODO(ui-verify import) step ${n + 1}: ${stepText}`);
      todos++;
    }
    for (const e of field('Expected')?.items ?? []) {
      const net = /^`([A-Z]+) (\/\S*)` returns (\d{3})$/.exec(e);
      if (net && !/[{}]/.test(net[2])) {
        out.push(`    AND network: ${net[1]} ${net[2]} returned ${net[3]}`);
      } else {
        out.push(`# TODO(ui-verify import) expect: ${e}`);
        todos++;
      }
    }
    out.push('');
  }
  return { text: out.join('\n'), todos };
}

/**
 * Turn aw-tester's compiled route files (`.agent/<branch>/.aw-tester/routes/*.md`,
 * written when a ui-verify intent spec passes) into grammar specs. Their header
 * comments are dropped; an `# uncompiled:` item was judged by observation and
 * has no grammar line, so it is reported for a person to add.
 *
 * @param {{ name: string, text: string }[]} files
 * @returns {{ text: string, warnings: string[] }}
 */
function routesToSpecs(files) {
  const out = [];
  const warnings = [];
  for (const { name, text } of files) {
    const uncompiled = /^# uncompiled:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (uncompiled && uncompiled !== 'none') {
      warnings.push(`${name}: ${uncompiled} was judged by observation and has no grammar line — add a THEN for it`);
    }
    const at = text.search(/^## Spec /m);
    if (at === -1) {
      warnings.push(`${name}: no \`## Spec\` block — skipped`);
      continue;
    }
    out.push(text.slice(at).trim(), '');
  }
  return { text: out.join('\n'), warnings };
}

/**
 * Wrap specs as a `<!-- ui-verify:v1 -->` block for a PR description, so
 * `/ui-verify run` executes the same checks against the preview. Specs are
 * renumbered `## Spec 1..n:`, the numbering aw-tester expects.
 *
 * @param {Spec[]} specs
 */
function specsToUiVerifyBlock(specs) {
  const bodies = specs.map((s, i) => {
    const [head, ...rest] = s.block.split('\n');
    return [head.replace(SPEC_HEADING, `## Spec ${i + 1}: ${s.title}`), ...rest].join('\n');
  });
  return [
    '<!-- ui-verify:v1 -->',
    '<details>',
    '<summary>🧪 UI verification spec — run against the preview deployment</summary>',
    '',
    'Target: preview',
    '',
    ...bodies.flatMap((b) => [b, '']),
    '</details>',
    '<!-- /ui-verify:v1 -->',
  ].join('\n');
}

module.exports = {
  SpecError,
  parseSpecFile,
  parseLocator,
  parseAction,
  parseAssertion,
  interpretPreconditions,
  routeToRegExp,
  urlPath,
  extractUiVerifyBlock,
  intentToDraft,
  routesToSpecs,
  specsToUiVerifyBlock,
};
