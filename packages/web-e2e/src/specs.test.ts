import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SpecError,
  extractUiVerifyBlock,
  intentToDraft,
  parseAction,
  parseAssertion,
  parseLocator,
  parseSpecFile,
  routeToRegExp,
  routesToSpecs,
  specsToUiVerifyBlock,
  urlPath,
} from './spec/grammar.cjs';
import { listSpecFiles, loadSpecs } from './spec/load';

/**
 * The browser-free half of the e2e suite, run by `nx test web-e2e` in the
 * `check` job on every PR that touches packages/web or this package:
 *
 *   • every spec file parses — a typo fails here, with file:line, before CI
 *     ever boots a browser;
 *   • every page.tsx under packages/web/src/app is visited by a spec;
 *   • the parser and the ui-verify import/export behave as specs/README.md says.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = path.resolve(HERE, '../specs');
const APP_DIR = path.resolve(HERE, '../../web/src/app');

/** `(dashboard)/settings/api-keys/page.tsx` → `/settings/api-keys`. */
function appRoutes(dir = APP_DIR, rel: string[] = []): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // `_private` folders and `@slot` parallel routes are not URL segments.
      if (name.startsWith('_') || name.startsWith('@')) continue;
      found.push(...appRoutes(full, [...rel, name]));
    } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(name)) {
      found.push(`/${rel.filter((s) => !/^\(.*\)$/.test(s)).join('/')}`);
    }
  }
  return found;
}

describe('spec files', () => {
  it('finds spec files', () => {
    expect(listSpecFiles(SPECS_DIR).length).toBeGreaterThan(0);
  });

  it('parses every spec file (a SpecError names the file and line)', () => {
    expect(() => loadSpecs(SPECS_DIR)).not.toThrow();
  });

  it('gives each spec in a file a unique id and title', () => {
    for (const file of listSpecFiles(SPECS_DIR)) {
      const specs = parseSpecFile(readFileSync(path.join(SPECS_DIR, file), 'utf8'), file);
      const dupe = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
      expect(dupe(specs.map((s) => s.id)), `${file}: duplicate spec ids`).toEqual([]);
      expect(dupe(specs.map((s) => s.title)), `${file}: duplicate spec titles`).toEqual([]);
    }
  });
});

describe('page coverage', () => {
  const routes = appRoutes().sort();
  const urls = loadSpecs(SPECS_DIR).map((s) => urlPath(s.url));

  it('finds the app router pages', () => {
    expect(routes.length, `no page.tsx under ${APP_DIR}`).toBeGreaterThan(0);
  });

  it('visits every page with at least one spec', () => {
    const missing = routes.filter((r) => !urls.some((u) => routeToRegExp(r).test(u)));
    expect(
      missing,
      'These pages have no e2e spec. Add one to packages/web-e2e/specs/pages.md (specs/README.md shows how):\n  ' +
        missing.join('\n  '),
    ).toEqual([]);
  });
});

describe('grammar', () => {
  it('parses locators, including commas inside strings and regexes', () => {
    expect(parseLocator('{role: "button", name: "Save, continue"} is clicked')).toEqual({
      locator: { role: 'button', name: 'Save, continue' },
      rest: 'is clicked',
    });
    const { locator } = parseLocator('{text: /save, continue/i}');
    expect(locator.text).toEqual(/save, continue/i);
    expect(parseLocator('{role: "link", name: "Docs", exact: false}').locator.exact).toBe(false);
  });

  it('refuses CSS selectors and unknown locator keys', () => {
    expect(() => parseLocator('.btn-primary is clicked')).toThrow(/CSS selectors/);
    expect(() => parseLocator('{css: ".x"}')).toThrow(/unknown locator key/);
    expect(() => parseLocator('{name: "Save"}')).toThrow(/exactly one of/);
  });

  it('parses every documented action and assertion', () => {
    expect(parseAction('page loads')).toEqual({ kind: 'load' });
    expect(parseAction('{label: "Email address"} is filled with "a@b.c"')).toMatchObject({
      kind: 'fill',
      value: 'a@b.c',
    });
    expect(parseAction('{label: "Password"} is pressed with "Enter"')).toMatchObject({ kind: 'press', value: 'Enter' });
    expect(parseAssertion('{role: "dialog", name: "Add"} is not visible')).toMatchObject({ kind: 'hidden' });
    expect(parseAssertion('{role: "option", name: "A"} has aria-selected: true')).toMatchObject({
      kind: 'attribute',
      attribute: 'aria-selected',
      value: 'true',
    });
    expect(parseAssertion('network: POST /api/x returned 201')).toEqual({
      kind: 'network',
      method: 'POST',
      path: '/api/x',
      status: 201,
    });
  });

  it('refuses `has text`, which would silently read as an attribute', () => {
    expect(() => parseAssertion('{role: "heading", name: "Blog"} has text: "Blog"')).toThrow(/not an attribute/);
  });

  it('reads "signed-in" with a hyphen as signed in', () => {
    expect(
      parseSpecFile(
        '## Spec 1: x\nurl: /lore\npreconditions:\n  - User is signed-in\nflow:\n  - WHEN page loads\n    THEN {text: "x"} is visible\n',
        'f.md',
      )[0].signedIn,
    ).toBe(true);
  });

  it('refuses what it cannot check deterministically, by name', () => {
    expect(() => parseAssertion('semantic: the user sees a confirmation')).toThrow(/LLM judge/);
    expect(() => parseSpecFile('Format: intent\n\n## Spec 1: x\n', 'f.md')).toThrow(/intent spec/);
    const chained = '## Spec 1: x\nurl: /\ncontinues-from: Spec 0\n';
    expect(() => parseSpecFile(chained, 'f.md')).toThrow(/continues-from is not supported/);
  });

  it('reports the file and line of a bad line', () => {
    const bad = '## Spec 1: x\nurl: /\nflow:\n  - WHEN {role: "button", name: "Go"} is double-clicked\n';
    expect(() => parseSpecFile(bad, 'specs/x.md')).toThrow(/^specs\/x\.md:4: unsupported action/);
    expect(() => parseSpecFile(bad, 'specs/x.md')).toThrow(SpecError);
  });

  it('refuses a spec that asserts nothing', () => {
    expect(() => parseSpecFile('## Spec 1: x\nurl: /\nflow:\n  - WHEN page loads\n', 'f.md')).toThrow(/asserts nothing/);
  });

  it('reads the two preconditions that change how a spec runs', () => {
    const [spec] = parseSpecFile(
      [
        '## Spec 1: x',
        'url: /settings/developer',
        'preconditions:',
        '  - User is logged in as admin (handled by aw-target auth)',
        '  - Not on production: 404s there',
        'flow:',
        '  - WHEN page loads',
        '    THEN {role: "heading", name: "Developer"} is visible',
      ].join('\n'),
      'f.md',
    );
    expect(spec.signedIn).toBe(true);
    expect(spec.skipOn).toEqual({ production: '404s there' });
  });

  it('matches app-router patterns to concrete urls', () => {
    expect(routeToRegExp('/docs/[slug]').test('/docs/offline')).toBe(true);
    expect(routeToRegExp('/docs/[slug]').test('/docs')).toBe(false);
    expect(routeToRegExp('/learn/[[...slug]]').test('/learn')).toBe(true);
    expect(routeToRegExp('/learn/[[...slug]]').test('/learn/a/b')).toBe(true);
    expect(routeToRegExp('/').test('/')).toBe(true);
    expect(routeToRegExp('/').test('/lore')).toBe(false);
  });
});

describe('ui-verify interop', () => {
  const journeys = readFileSync(path.join(SPECS_DIR, 'journeys.md'), 'utf8');

  it('round-trips specs through a ui-verify v1 block unchanged', () => {
    const specs = parseSpecFile(journeys, 'journeys.md');
    const block = specsToUiVerifyBlock(specs);
    expect(block.startsWith('<!-- ui-verify:v1 -->')).toBe(true);
    const extracted = extractUiVerifyBlock(`PR text\n\n${block}\n\nmore text`);
    expect(extracted?.version).toBe('v1');
    const again = parseSpecFile(extracted?.content ?? '', 'pr.md');
    // Same url and steps; only the source line numbers move inside a PR block.
    const shape = (xs: typeof specs) =>
      JSON.parse(JSON.stringify(xs.map((s) => [s.title, s.url, s.flow]), (k, v) => (k === 'line' ? undefined : v)));
    expect(shape(again)).toEqual(shape(specs));
  });

  it('renumbers specs from several files 1..n when exporting a block', () => {
    const pages = readFileSync(path.join(SPECS_DIR, 'pages.md'), 'utf8');
    const specs = [...parseSpecFile(pages, 'pages.md'), ...parseSpecFile(journeys, 'journeys.md')];
    const extracted = extractUiVerifyBlock(specsToUiVerifyBlock(specs));
    const ids = parseSpecFile(extracted?.content ?? '', 'pr.md').map((s) => s.id);
    expect(ids).toEqual(specs.map((_, i) => String(i + 1)));
  });

  it('turns an intent (v2) spec into a draft that cannot run until finished', () => {
    const intent = [
      '<!-- ui-verify:v2 -->',
      '<details>',
      '<summary>🧪 UI verification spec</summary>',
      '',
      'Target: preview',
      'Format: intent',
      '',
      '## Spec 1: A user renames a dashboard',
      '**Changed:** the Rename button in the dashboard header',
      '**Start:** /dashboards/abc',
      '**Steps:**',
      '1. Open the dashboard.',
      '2. [must-follow] Click **Rename** in the dashboard header.',
      '**Expected:**',
      '- The header shows "Q3 revenue" without a page reload.',
      '- `PATCH /api/dashboards/abc` returns 200',
      '**Hints:**',
      '- The name field is {role: "textbox", name: "Dashboard name"}.',
      '',
      '</details>',
      '<!-- /ui-verify:v2 -->',
    ].join('\n');
    const block = extractUiVerifyBlock(intent);
    expect(block?.version).toBe('v2');
    const { text, todos } = intentToDraft(block?.content ?? '');
    expect(todos).toBe(3);
    expect(text).toContain('url: /dashboards/abc');
    expect(text).toContain('    AND network: PATCH /api/dashboards/abc returned 200');
    expect(text).toContain('# hint: The name field is {role: "textbox", name: "Dashboard name"}.');
    expect(() => parseSpecFile(text, 'draft.md')).toThrow(/unfinished imported step/);
  });

  it('imports compiled routes and names the outcomes they could not compile', () => {
    const route = [
      '# route-for: Spec-1',
      '# source-sha: 3fa9c2e1',
      '# deviations: none',
      '# uncompiled: E2',
      '# mutations: none',
      '## Spec 1: A user opens the docs',
      'url: /',
      'flow:',
      '  - WHEN {role: "link", name: "Docs"} is clicked',
      '    THEN {role: "heading", name: "Getting started"} is visible',
    ].join('\n');
    const { text, warnings } = routesToSpecs([{ name: 'Spec-1-3fa9c2e1.md', text: route }]);
    expect(parseSpecFile(text, 'routes.md')).toHaveLength(1);
    expect(warnings).toEqual([expect.stringMatching(/E2 was judged by observation/)]);
  });
});
