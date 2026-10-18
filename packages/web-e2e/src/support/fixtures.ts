import { test as base, expect } from '@playwright/test';
import { BASE_URL } from './env';

const ORIGIN = new URL(BASE_URL).origin;

/**
 * Console errors ANY page may emit without failing its test. Every entry needs
 * a reason — an allowlist nobody can explain is how real errors get hidden.
 */
const GLOBAL_ALLOWED_PROBLEMS: RegExp[] = [
  // A blog post's like counter fetches <supabase>/functions/v1/blog/likes and
  // swallows a failure by design (PostLikes.tsx); a local build with no Supabase
  // behind it cannot reach it. Likes are not core — the post is.
  /functions\/v1\/blog\/likes/,
];

export interface PageHealthOptions {
  /**
   * Extra problems to tolerate for the current test, matched against the
   * rendered problem line (`console.error: <text> (<url>)`,
   * `uncaught exception: <message>`, `HTTP <status> <method> <url>`).
   */
  allowedConsoleErrors: RegExp[];
}

/**
 * The suite's `test`: Playwright's, plus a health check every spec gets for
 * free. Each test records uncaught page exceptions, console errors and
 * same-origin 5xx responses, and fails when any were seen — so a hydration
 * error or a crashing component fails the smoke even when the heading still
 * rendered. A spec that asserts its own error status (`network: GET /x
 * returned 404`) tolerates that status's console line; anything else known and
 * harmless goes in GLOBAL_ALLOWED_PROBLEMS with a reason, or
 * `test.use({ allowedConsoleErrors: allowing([...]) })` in a TS journey.
 */
export const test = base.extend<PageHealthOptions & { pageProblems: string[] }>({
  allowedConsoleErrors: [[], { option: true }],

  pageProblems: [
    async ({ page, allowedConsoleErrors }, use, testInfo) => {
      const problems: string[] = [];
      const allowed = [...GLOBAL_ALLOWED_PROBLEMS, ...allowedConsoleErrors];
      const record = (line: string) => {
        if (!allowed.some((re) => re.test(line))) problems.push(line);
      };

      page.on('pageerror', (err) => record(`uncaught exception: ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const where = msg.location()?.url;
        record(`console.error: ${msg.text()}${where ? ` (${where})` : ''}`);
      });
      page.on('response', (res) => {
        if (res.status() < 500) return;
        if (new URL(res.url()).origin !== ORIGIN) return;
        record(`HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
      });

      await use(problems);

      if (problems.length === 0) return;
      await testInfo.attach('page-problems', { body: problems.join('\n'), contentType: 'text/plain' });
      // Only assert on an otherwise-passing test: a failed test already says
      // what went wrong, and the attachment carries the rest.
      if (testInfo.status === testInfo.expectedStatus) {
        expect(
          problems,
          'The page reported errors (listed above). Fix them, or — if one is known and harmless — allow it ' +
            'in GLOBAL_ALLOWED_PROBLEMS (src/support/fixtures.ts) with the reason.',
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };

/**
 * The `test.use` value for `allowedConsoleErrors`. Never pass the bare array:
 * Playwright reads any array whose second element is an object as a
 * `[value, options]` tuple, so `[/a/, /b/]` would become the value `/a/`.
 */
export const allowing = (patterns: RegExp[]): [RegExp[], { scope: 'test' }] => [patterns, { scope: 'test' }];
