import type { Preview } from '@storybook/nextjs-vite';
import type { ReactNode } from 'react';

// Tailwind v4 + the app's design tokens (`@theme` custom properties). Importing
// the real stylesheet means stories render with the exact same tokens the app
// ships — the whole point of visual-regression coverage.
import '../src/app/globals.css';

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
      {children}
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
};

export default preview;
