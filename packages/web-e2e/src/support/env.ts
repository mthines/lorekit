/**
 * Everything the suite reads from the environment, resolved in ONE place so a
 * spec never reaches for `process.env` itself.
 *
 * ## Where the suite points
 *
 *   E2E_BASE_URL   the site under test. Unset → Playwright boots a local
 *                  `next start` on E2E_PORT (see playwright.config.ts) against
 *                  a build made with NEXT_PUBLIC_USE_LOCAL_SUPABASE=true.
 *   E2E_TARGET     local | preview | production. Inferred from the URL when
 *                  unset (localhost → local, lorekit.io → production, anything
 *                  else → preview). Set it explicitly when the URL does not say
 *                  which backend it talks to — a STAGED production build on a
 *                  *.vercel.app URL is `production`.
 *
 * ## Getting through Vercel Deployment Protection
 *
 *   VERCEL_AUTOMATION_BYPASS_SECRET   sent as `x-vercel-protection-bypass` on
 *                  requests to the site's own origin only (never to Supabase,
 *                  where the extra header would fail the CORS preflight).
 *
 * ## Signing in (the `signed-in` project)
 *
 * The first source that is set wins:
 *
 *   1. E2E_USER_EMAIL + E2E_USER_PASSWORD — a fixed, pre-existing test account.
 *      LOREKIT_TESTING_USER_NAME + LOREKIT_TESTING_USER_PW are accepted as
 *      aliases, so the credentials aw-tester already uses work unchanged.
 *   2. E2E_SUPABASE_URL + E2E_SUPABASE_SERVICE_ROLE_KEY — provision a throwaway
 *      confirmed user through the Auth admin API. LOCAL STACKS ONLY: anything
 *      that is not localhost/127.0.0.1 is refused, so a run can never create
 *      users in a real tenant (the same rule scripts/smoke/mint-smoke-jwt.mjs
 *      follows).
 *   3. Neither → every signed-in test is skipped, and the reason is printed.
 */

export type TargetKind = 'local' | 'preview' | 'production';

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
};

export const E2E_PORT = Number(env('E2E_PORT') ?? 3100);

/** The origin under test, without a trailing slash. */
export const BASE_URL = (env('E2E_BASE_URL') ?? `http://127.0.0.1:${E2E_PORT}`).replace(/\/+$/, '');

/** True when Playwright must start the site itself. */
export const STARTS_LOCAL_SERVER = !env('E2E_BASE_URL');

function inferTarget(url: string): TargetKind {
  const host = new URL(url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'local';
  if (host === 'lorekit.io' || host.endsWith('.lorekit.io')) return 'production';
  return 'preview';
}

export const TARGET: TargetKind = (() => {
  const explicit = env('E2E_TARGET');
  if (explicit === 'local' || explicit === 'preview' || explicit === 'production') return explicit;
  if (explicit) throw new Error(`E2E_TARGET must be local | preview | production, got "${explicit}"`);
  return inferTarget(BASE_URL);
})();

export const VERCEL_BYPASS_SECRET = env('VERCEL_AUTOMATION_BYPASS_SECRET');

export interface FixedUser {
  kind: 'fixed';
  email: string;
  password: string;
}
export interface ProvisionedUser {
  kind: 'provision';
  supabaseUrl: string;
  serviceRoleKey: string;
}
export type UserSource = FixedUser | ProvisionedUser;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function resolveUserSource(): { source: UserSource | null; reason: string } {
  const email = env('E2E_USER_EMAIL') ?? env('LOREKIT_TESTING_USER_NAME');
  const password = env('E2E_USER_PASSWORD') ?? env('LOREKIT_TESTING_USER_PW');
  if (email && password) return { source: { kind: 'fixed', email, password }, reason: '' };

  const supabaseUrl = env('E2E_SUPABASE_URL');
  const serviceRoleKey = env('E2E_SUPABASE_SERVICE_ROLE_KEY');
  if (supabaseUrl && serviceRoleKey) {
    const host = new URL(supabaseUrl).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `E2E_SUPABASE_URL points at ${host}: throwaway users are only provisioned on a local stack. ` +
          'Use E2E_USER_EMAIL / E2E_USER_PASSWORD for a real project.',
      );
    }
    return { source: { kind: 'provision', supabaseUrl: supabaseUrl.replace(/\/+$/, ''), serviceRoleKey }, reason: '' };
  }

  return {
    source: null,
    reason:
      'no test user: set E2E_USER_EMAIL + E2E_USER_PASSWORD (or LOREKIT_TESTING_USER_NAME + LOREKIT_TESTING_USER_PW), ' +
      'or E2E_SUPABASE_URL + E2E_SUPABASE_SERVICE_ROLE_KEY for a local stack',
  };
}

const resolved = resolveUserSource();

/** How the `signed-in` project gets a user, or null when it cannot. */
export const USER_SOURCE: UserSource | null = resolved.source;

/** Why signed-in tests are skipped (empty when they run). */
export const NO_USER_REASON = resolved.reason;

/**
 * True when the site under test has a reachable auth backend. A local build
 * with no `supabase start` behind it (the default PR job) has none, so tests
 * that submit credentials skip there instead of asserting a network error.
 */
export const HAS_AUTH_BACKEND = USER_SOURCE !== null || TARGET !== 'local';
