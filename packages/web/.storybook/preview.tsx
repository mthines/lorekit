import type { Preview } from '@storybook/nextjs-vite';
import type { ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { initialize, mswLoader } from 'msw-storybook-addon';

// Tailwind v4 + the app's design tokens (`@theme` custom properties). Importing
// the real stylesheet means stories render with the exact same tokens the app
// ships — the whole point of visual-regression coverage.
import '../src/app/globals.css';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase env for the MSW-mocked full-page stories.
//
// The browser/server Supabase clients read `process.env['NEXT_PUBLIC_SUPABASE_*']`
// at call time to build the PostgREST URL. There is no committed `.env.local`, so
// pin the public production ref (non-secret, per CLAUDE.md's "always the concrete
// endpoint" rule) and a placeholder anon key here. Every outgoing request is
// intercepted by MSW — nothing ever reaches the real host — but the client still
// needs a valid URL to construct one. Guarded so a define-frozen `process.env`
// (should the framework ever inline it) never throws.
// ─────────────────────────────────────────────────────────────────────────────
try {
  const env = (process as { env?: Record<string, string | undefined> }).env;
  if (env) {
    env['NEXT_PUBLIC_SUPABASE_URL'] ??= 'https://pqokxlhvnosogizsjztg.supabase.co';
    env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ??= 'sb_publishable_storybook_mock_key';
    env['NEXT_PUBLIC_SUPABASE_PROJECT_REF'] ??= 'pqokxlhvnosogizsjztg';
  }
} catch {
  // Ignore — a story that needs the URL will surface it via the MSW wildcard.
}

// Register the MSW service worker once. `onUnhandledRequest: 'bypass'` lets story
// assets (fonts, chunks) through untouched; only the Supabase endpoints declared
// in each story's `parameters.msw.handlers` are intercepted. The worker file is
// `public/mockServiceWorker.js` (committed via `msw init`), served at the root by
// both the Vitest browser run and the deployed static Storybook.
initialize({
  onUnhandledRequest: 'bypass',
  serviceWorker: { url: '/mockServiceWorker.js' },
});

/**
 * Global decorator: paint the app's dark surface behind every story and kill
 * animations/transitions so pixel snapshots are deterministic.
 *
 * Disabling motion (and hiding the caret) is what keeps `toMatchScreenshot`
 * from flaking on mid-transition frames — the standard visual-regression
 * stabilisation. Fonts fall back to the browser's system stack (Inter/Fira are
 * not bundled), which is consistent between local and CI because both run the
 * same pinned Chromium build.
 */
function ThemeFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="font-sans text-[var(--color-content-primary)]"
      style={{ background: 'var(--color-bg)', padding: '1.5rem', minHeight: '100%' }}
    >
      <style>{`
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          caret-color: transparent !important;
        }
      `}</style>
      {/* The CSS override above kills CSS transitions/animations, but `motion`
          (framer) drives entrance animations via JS transforms/opacity that the
          stylesheet can't reach — a card mid-fade would flake the snapshot.
          `MotionConfig` collapses every motion animation to an instant jump-to-end
          so time-relative renders are deterministic. Inert for the existing
          component stories (none render `motion` elements), so their committed
          baselines are unaffected. */}
      <MotionConfig transition={{ duration: 0 }} reducedMotion="always">
        {children}
      </MotionConfig>
    </div>
  );
}

const preview: Preview = {
  parameters: {
    layout: 'centered',
    // The dashboard is a dark-only surface; match it so snapshots read true.
    backgrounds: { disable: true },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  decorators: [
    (Story) => (
      <ThemeFrame>
        <Story />
      </ThemeFrame>
    ),
  ],
  // MSW loader runs before every story. Stories with no `parameters.msw.handlers`
  // register no handlers, so their (nonexistent) network calls simply bypass —
  // the existing component stories are unaffected.
  loaders: [mswLoader],
};

export default preview;
