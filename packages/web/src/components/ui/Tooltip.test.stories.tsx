import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';

import { Tooltip } from './Tooltip';

/**
 * Interaction tests for {@link Tooltip} — the `play` functions run in a real
 * browser via `@storybook/addon-vitest`. Kept in the `/Tests` namespace and
 * `test`-tagged so the `storybook-interaction` Vitest project picks them up and
 * the `storybook-visual` project skips them (no snapshots).
 */
const meta: Meta<typeof Tooltip> = {
  title: 'UI/Tooltip/Tests',
  component: Tooltip,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
  render: (args) => (
    <Tooltip {...args}>
      <button type="button">Copy</button>
    </Tooltip>
  ),
  args: {
    content: 'Copied to clipboard',
  },
};

export default meta;
type Story = StoryObj<typeof Tooltip>;

export const HoverRevealsTooltip: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByRole('button', { name: /copy/i });

    await step('Tooltip is hidden at rest', async () => {
      await expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    await step('Hovering the trigger reveals the tooltip', async () => {
      await userEvent.hover(trigger);
      const tip = await canvas.findByRole('tooltip');
      await expect(tip).toHaveTextContent(/copied to clipboard/i);
      // The trigger points screen readers at the now-visible panel.
      await expect(trigger.parentElement).toHaveAttribute('aria-describedby');
    });

    await step('Moving away hides the tooltip again', async () => {
      await userEvent.unhover(trigger);
      await expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  },
};

export const EscapeDismissesTooltip: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByRole('button', { name: /copy/i });

    await step('Open the tooltip via hover', async () => {
      await userEvent.hover(trigger);
      await expect(await canvas.findByRole('tooltip')).toBeVisible();
    });

    await step('Escape dismisses it', async () => {
      await userEvent.keyboard('{Escape}');
      await expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  },
};
