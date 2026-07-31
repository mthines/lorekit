import type { StorybookConfig } from '@storybook/nextjs-vite';

// ── Self-contained Supabase env for the standalone Storybook build ───────────
// The dashboard's createClient() calls
//   createBrowserClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, ...ANON_KEY!)
// which THROWS ("Your project's URL and Key are required to create a Supabase
// client") if either is empty — at construction time, before any request, so
// MSW (which only mocks requests) cannot prevent it. Storybook inlines the
// NEXT_PUBLIC_* vars from the build process's env; the SEPARATE Storybook
// Vercel project has none set, so the deployed build baked in empty strings and
// threw. main.ts is the first module the Storybook Node process loads (before
// the nextjs-vite preset inlines env), so seed mock public values here — the
// build then stays self-contained and never depends on the Vercel project's
// env. Every request is MSW-mocked, so these are placeholders (any valid,
// non-empty URL/key works); `??=` yields to a real value when one is present
// (local dev / the main app's Vercel project).
process.env['NEXT_PUBLIC_SUPABASE_URL'] ??= 'https://pqokxlhvnosogizsjztg.supabase.co';
process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ??= 'sb_publishable_storybook_mock_key';
process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF'] ??= 'pqokxlhvnosogizsjztg';

/**
 * Storybook config for the LoreKit dashboard.
 *
 * Framework is `@storybook/nextjs-vite` (Vite-powered, not webpack) — the
 * Vitest addon requires a Vite builder, so this is the only Next.js framework
 * that can run stories as Vitest browser tests. `@storybook/addon-vitest`
 * turns every story into a test: interaction (`play`) stories become
 * interaction tests, and the visual project screenshots each story.
 *
 * The stories glob deliberately matches BOTH files per component:
 *   - `<name>.stories.tsx`      — visual-regression stories (Default + Playground)
 *   - `<name>.test.stories.tsx` — interaction tests under the `/Tests` namespace
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-vitest'],
  framework: {
    name: '@storybook/nextjs-vite',
    options: {},
  },
  // Serve the Next.js `public/` dir at the Storybook root so the MSW service
  // worker (`public/mockServiceWorker.js`, committed via `msw init`) is reachable
  // at `/mockServiceWorker.js` — in both the Vitest browser run AND the deployed
  // static Storybook, so the MSW-mocked stories work on the hosted Vercel build.
  staticDirs: ['../public'],
  core: {
    disableTelemetry: true,
  },
};

export default config;
