import type { TargetKind } from './support/env';

/**
 * Every page of the LoreKit website, and what a visitor must see on it.
 *
 * This table IS the page smoke suite: `pages.e2e.ts` turns each entry into
 * tests, and `routes.test.ts` fails the PR when a `page.tsx` under
 * packages/web/src/app has no entry here (or an entry names a page that no
 * longer exists). Adding a page therefore means adding one object below.
 *
 * What each entry produces:
 *
 *   access: 'public'     → "renders for a signed-out visitor"
 *   access: 'signed-in'  → "sends a signed-out visitor to /login?next=<path>"
 *                          (runs everywhere, no credentials needed), and
 *                          "renders for a signed-in user" (runs when a test
 *                          user is configured — see support/env.ts)
 *
 * Assert on what a person sees: the page's heading, exactly as rendered. No
 * page carries a data-testid today, and a heading changing is a real change
 * worth a one-line update here.
 */

export type Access = 'public' | 'signed-in';

export interface Heading {
  /** Heading level. Settings pages share the h1 "Settings", so they assert their h2. */
  level: 1 | 2;
  /** Exact accessible name, or a pattern when the heading is split across elements. */
  name: string | RegExp;
}

export interface RouteCheck {
  /**
   * The route as the app router names it: the directory path of a `page.tsx`
   * under packages/web/src/app, with route groups like `(dashboard)` removed.
   * `/docs/[slug]`, not `/docs/offline`. The coverage guard matches on this.
   */
  route: string;
  /** The URL to visit. Defaults to `route`; required for a dynamic route. */
  path?: string;
  access: Access;
  /** What the visitor must see once the page has settled. */
  heading: Heading;
  /** The pathname the visit ends on, when the page redirects (e.g. `/docs` → `/docs/setup`). */
  landsOn?: string;
  /**
   * Known, harmless problems to tolerate on this page only (see
   * support/fixtures.ts for the line format). Say why in a comment.
   */
  allowConsoleErrors?: RegExp[];
  /** Skip on one kind of target, with the reason. The entry still counts as covered. */
  skipOn?: Partial<Record<TargetKind, string>>;
}

export const ROUTES: RouteCheck[] = [
  // ── Marketing, auth and content (public) ─────────────────────────────────
  {
    route: '/',
    access: 'public',
    // Two block spans inside one h1, so match on the first sentence.
    heading: { level: 1, name: /Your coding agents forget\./ },
  },
  { route: '/login', access: 'public', heading: { level: 1, name: 'Sign in to LoreKit' } },
  { route: '/forgot-password', access: 'public', heading: { level: 1, name: 'Reset your password' } },
  // Signed out, this also shows "This reset link is invalid…" — expected.
  { route: '/update-password', access: 'public', heading: { level: 1, name: 'Set a new password' } },
  { route: '/welcome', access: 'public', heading: { level: 1, name: 'Welcome to LoreKit' } },
  { route: '/blog', access: 'public', heading: { level: 1, name: 'Blog' } },
  {
    route: '/blog/[slug]',
    path: '/blog/self-healing-agents',
    access: 'public',
    heading: { level: 1, name: 'Self-healing agents are just a loop you forgot to build' },
    allowConsoleErrors: [
      // The like counter fetches <supabase>/functions/v1/blog/likes and
      // swallows a failure by design (PostLikes.tsx); a local build with no
      // Supabase behind it cannot reach it. Likes are not core — the post is.
      /blog\/likes/,
    ],
  },
  { route: '/docs', access: 'public', landsOn: '/docs/setup', heading: { level: 1, name: 'Getting started' } },
  { route: '/docs/[slug]', path: '/docs/offline', access: 'public', heading: { level: 1, name: 'Offline storage' } },
  {
    route: '/learn/[[...slug]]',
    path: '/learn/remote',
    access: 'public',
    landsOn: '/docs/remote',
    heading: { level: 1, name: 'Remote storage' },
  },

  // ── Dashboard (signed in) ────────────────────────────────────────────────
  // Note: opening /lore as a user with no API tokens creates one ("My first
  // token") — onboarding-steps.tsx. Harmless for a test account.
  { route: '/lore', access: 'signed-in', heading: { level: 1, name: 'Lore Explorer' } },
  { route: '/insights', access: 'signed-in', heading: { level: 1, name: 'Insights' } },
  {
    route: '/onboarding',
    access: 'signed-in',
    landsOn: '/docs/setup',
    heading: { level: 1, name: 'Getting started' },
  },

  // Settings: every page shares the h1 "Settings"; each section is its h2.
  { route: '/settings/api-keys', access: 'signed-in', heading: { level: 2, name: 'API keys' } },
  { route: '/settings/audit', access: 'signed-in', heading: { level: 2, name: 'Audit Logs' } },
  {
    route: '/settings/developer',
    access: 'signed-in',
    heading: { level: 2, name: 'Developer' },
    skipOn: {
      production: 'answers 404 in production for any account not in DEVELOPER_EMAILS (lib/developer-users.ts)',
    },
  },
  // Behind the `retention-policies` flag (default on).
  { route: '/settings/grooming', access: 'signed-in', heading: { level: 2, name: 'Retention Policies' } },
  // The nav says "Integrations"; the section heading is "GitHub App".
  { route: '/settings/integrations', access: 'signed-in', heading: { level: 2, name: 'GitHub App' } },
  { route: '/settings/organization', access: 'signed-in', heading: { level: 2, name: 'Organization' } },
  { route: '/settings/plan', access: 'signed-in', heading: { level: 2, name: 'Plan' } },
  { route: '/settings/user', access: 'signed-in', heading: { level: 2, name: 'User' } },

  // Tutorials moved to /docs; each old URL forwards to its doc.
  { route: '/tutorials', access: 'signed-in', landsOn: '/docs/offline', heading: { level: 1, name: 'Offline storage' } },
  {
    route: '/tutorials/offline',
    access: 'signed-in',
    landsOn: '/docs/offline',
    heading: { level: 1, name: 'Offline storage' },
  },
  {
    route: '/tutorials/organization',
    access: 'signed-in',
    landsOn: '/docs/organization',
    heading: { level: 1, name: 'Team sharing' },
  },
  {
    route: '/tutorials/private',
    access: 'signed-in',
    landsOn: '/docs/private',
    heading: { level: 1, name: 'Private lore' },
  },
  {
    route: '/tutorials/remote',
    access: 'signed-in',
    landsOn: '/docs/remote',
    heading: { level: 1, name: 'Remote storage' },
  },
  { route: '/tutorials/tags', access: 'signed-in', landsOn: '/docs/tags', heading: { level: 1, name: 'Tags & scopes' } },
  {
    route: '/tutorials/use-cases',
    access: 'signed-in',
    landsOn: '/docs/use-cases',
    heading: { level: 1, name: 'Use cases' },
  },
];

/** The URL a check visits. */
export const visitPath = (r: RouteCheck): string => r.path ?? r.route;
