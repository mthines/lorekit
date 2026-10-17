import { test as base, expect } from '@playwright/test';
import { BASE_URL, VERCEL_BYPASS_SECRET } from './env';

const ORIGIN = new URL(BASE_URL).origin;

/**
 * Console errors ANY page may emit without failing its test. Every entry needs
 * a reason — an allowlist nobody can explain is how real errors get hidden.
 * Prefer a per-route `allowConsoleErrors` in routes.ts over growing this list.
 */
const GLOBAL_ALLOWED_PROBLEMS: RegExp[] = [];

export interface PageHealthOptions {
  /**
   * Extra problems to tolerate for the current test, matched against the
   * rendered problem line (`console.error: <text> (<url>)`,
   * `uncaught exception: <message>`, `HTTP <status> <method> <url>`).
   */
  allowedConsoleErrors: RegExp[];
}

/**
 * The suite's `test`: Playwright's, plus two things every spec gets for free.
 *
 *   • A health check. Each test records uncaught page exceptions, console
 *     errors and same-origin 5xx responses, and fails when any were seen — so
 *     a hydration error or a crashing component fails the smoke even when the
 *     heading still rendered. Allow a known one with `allowConsoleErrors` on the
 *     route (routes.ts) or `test.use({ allowedConsoleErrors: [...] })`.
 *   • The Vercel bypass header on requests to the site's OWN origin when
 *     VERCEL_AUTOMATION_BYPASS_SECRET is set. Only that origin: adding it to
 *     every request (`extraHTTPHeaders`) would put an unexpected header on the
 *     app's Supabase calls and fail their CORS preflight.
 */
export const test = base.extend<PageHealthOptions & { pageProblems: string[] }>({
  allowedConsoleErrors: [[], { option: true }],

  context: async ({ context }, use) => {
    const secret = VERCEL_BYPASS_SECRET;
    if (secret) {
      await context.route(
        (url) => url.origin === ORIGIN,
        (route) =>
          route.continue({
            headers: { ...route.request().headers(), 'x-vercel-protection-bypass': secret },
          }),
      );
    }
    await use(context);
  },

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
            'with `allowConsoleErrors` on the route in src/routes.ts.',
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };

/** Headers for `request.*` calls that must get through Vercel Deployment Protection. */
export function originHeaders(): Record<string, string> {
  return VERCEL_BYPASS_SECRET ? { 'x-vercel-protection-bypass': VERCEL_BYPASS_SECRET } : {};
}
