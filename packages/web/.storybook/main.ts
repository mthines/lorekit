import type { StorybookConfig } from '@storybook/nextjs-vite';

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
  core: {
    disableTelemetry: true,
  },
};

export default config;
