import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { GroomingRuleBuilder } from './GroomingRuleBuilder';
import { groomHandlers } from '@/mocks/memories';
import { withQueryClient } from '@/mocks/decorators';
import { ToastProvider } from '@/components/providers/ToastProvider';

/**
 * Interaction tests for {@link GroomingRuleBuilder}: filling in a scope +
 * condition shows a live match count via `groom/preview`, the "Auto (nightly)"
 * switch toggles, and "Run now" archives the matches via `groom/run`.
 * `/Tests` namespace, `test`-tagged, `chromatic.disableSnapshot` so the visual
 * `afterEach` skips these (per `docs/storybook.md`).
 */
function WithToast({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

const meta: Meta<typeof GroomingRuleBuilder> = {
  title: 'Settings/GroomingRuleBuilder/Tests',
  component: GroomingRuleBuilder,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: groomHandlers() },
  },
  decorators: [(Story) => <WithToast><Story /></WithToast>, withQueryClient],
};

export default meta;
type Story = StoryObj<typeof GroomingRuleBuilder>;

export const PreviewToggleAndRun: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the Run now button renders', async () => {
      await expect(await canvas.findByRole('button', { name: /run now/i })).toBeInTheDocument();
    });

    await step('filling in a scope + minimum age shows a live match count', async () => {
      const scopeInput = await canvas.findByLabelText('Scope');
      await userEvent.type(scopeInput, 'repo::acme/app');

      const minAgeInput = await canvas.findByLabelText('Minimum age (days)');
      await userEvent.type(minAgeInput, '30');

      await waitFor(
        async () => {
          await expect(canvas.getByText(/match/i)).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });

    await step('the Auto (nightly) switch toggles on click', async () => {
      const toggle = canvas.getByRole('switch', { name: 'Auto (nightly)' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(toggle);
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    await step('Run now archives the matches', async () => {
      const runButton = canvas.getByRole('button', { name: /run now/i });
      await userEvent.click(runButton);

      // Both the inline success message AND the (transient) toast say
      // "Archived …", so this asserts at least one rather than a single match.
      await waitFor(
        async () => {
          const matches = await canvas.findAllByText(/archived/i);
          await expect(matches.length).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
    });
  },
};
