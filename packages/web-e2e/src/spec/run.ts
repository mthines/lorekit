import type { Locator as PwLocator, Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import type { Assertion, FlowItem, Locator, Spec } from './grammar.cjs';
import { urlPath } from './grammar.cjs';

/**
 * Executes one parsed spec (grammar.cjs) in Playwright. The mapping is the one
 * aw-tester uses for the same grammar, so a spec behaves the same in CI and in
 * `/ui-verify run`:
 *
 *   {role, name}   → getByRole(role, { name, exact })   (exact defaults to true)
 *   {label} / {placeholder} / {text} → getByLabel / getByPlaceholder / getByText
 *   {testid}       → getByTestId                         (escape hatch)
 *
 * Every locator is strict: matching two elements fails the step and asks you
 * to name the instance, exactly like aw-tester.
 */

type ResponseRecord = { method: string; path: string; status: number };

function resolve(page: Page, l: Locator): PwLocator {
  const exactFor = (v: string | RegExp | undefined) => (typeof v === 'string' ? (l.exact ?? true) : undefined);
  if (l.role) {
    // The grammar allows multi-word roles ("menu item"); ARIA spells them as one word.
    const role = l.role.replace(/\s+/g, '') as Parameters<Page['getByRole']>[0];
    return page.getByRole(role, l.name === undefined ? {} : { name: l.name, exact: exactFor(l.name) });
  }
  if (l.label !== undefined) return page.getByLabel(l.label, { exact: exactFor(l.label) });
  if (l.placeholder !== undefined) return page.getByPlaceholder(l.placeholder, { exact: exactFor(l.placeholder) });
  if (l.text !== undefined) return page.getByText(l.text, { exact: exactFor(l.text) });
  if (l.testid !== undefined) return page.getByTestId(l.testid);
  throw new Error(`unsupported locator ${JSON.stringify(l)}`);
}

/** Network assertions whose expected status is an error the spec WANTS (e.g. a 404 page). */
export function expectedErrorStatuses(spec: Spec): number[] {
  return spec.flow.flatMap((f) =>
    f.kind === 'step'
      ? f.assertions
          .map((a) => a.assertion)
          .filter((a): a is Extract<Assertion, { kind: 'network' }> => a.kind === 'network' && a.status >= 400)
          .map((a) => a.status)
      : [],
  );
}

async function assertOne(page: Page, a: Assertion, responses: ResponseRecord[]) {
  switch (a.kind) {
    case 'visible':
      await expect(resolve(page, a.locator)).toBeVisible();
      return;
    case 'hidden':
      await expect(resolve(page, a.locator)).toBeHidden();
      return;
    case 'attribute':
      await expect(resolve(page, a.locator)).toHaveAttribute(a.attribute, a.value);
      return;
    case 'network': {
      const seen = () => responses.some((r) => r.method === a.method && r.path === a.path && r.status === a.status);
      await expect
        .poll(seen, {
          message: `no ${a.method} ${a.path} answered ${a.status}. Seen for that path: ${
            responses
              .filter((r) => r.path === a.path)
              .map((r) => `${r.method} ${r.status}`)
              .join(', ') || 'nothing'
          }`,
        })
        .toBe(true);
      return;
    }
  }
}

async function runItem(page: Page, item: FlowItem, responses: ResponseRecord[], testInfo: TestInfo) {
  if (item.kind === 'capture') {
    const body = await page.screenshot({ fullPage: item.fullPage });
    await testInfo.attach(item.label, { body, contentType: 'image/png' });
    return;
  }
  const { action } = item;
  if (action.kind === 'load') await page.waitForLoadState('domcontentloaded');
  else if (action.kind === 'click') await resolve(page, action.locator).click();
  else if (action.kind === 'check') await resolve(page, action.locator).check();
  else if (action.kind === 'hover') await resolve(page, action.locator).hover();
  else if (action.kind === 'fill') await resolve(page, action.locator).fill(action.value);
  else if (action.kind === 'press') await resolve(page, action.locator).press(action.value);

  for (const { assertion, source, line } of item.assertions) {
    await test.step(`${source}  (line ${line})`, () => assertOne(page, assertion, responses));
  }
}

/** Open the spec's url and run its flow, one report step per WHEN / THEN line. */
export async function runSpec(page: Page, spec: Spec, testInfo: TestInfo): Promise<void> {
  const responses: ResponseRecord[] = [];
  page.on('response', (r) =>
    responses.push({ method: r.request().method(), path: new URL(r.url()).pathname, status: r.status() }),
  );

  const response = await test.step(`url: ${spec.url}`, () => page.goto(spec.url));
  // The document must load — unless the spec asserts its own error status
  // (`network: GET /missing returned 404`), in which case that line checks it.
  const ownStatusAsserted = spec.flow.some(
    (f) =>
      f.kind === 'step' &&
      f.assertions.some((a) => a.assertion.kind === 'network' && a.assertion.path === urlPath(spec.url)),
  );
  if (!ownStatusAsserted) {
    expect(response?.status() ?? 0, `HTTP status for ${spec.url} (0 = no response)`).toBeGreaterThan(0);
    expect(response?.status() ?? 0, `HTTP status for ${spec.url}`).toBeLessThan(400);
  }

  for (const item of spec.flow) {
    await test.step(`${item.source}  (line ${item.line})`, () => runItem(page, item, responses, testInfo));
  }
}
