import type { Meta, StoryObj } from '@storybook/react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';

import { Tooltip } from './Tooltip';

/**
 * Interaction tests for {@link Tooltip} — the `play` functions run in a real
 * browser via `@storybook/addon-vitest`. Kept in the `/Tests` namespace and
 * `test`-tagged, with `chromatic.disableSnapshot` so the visual-regression
 * `afterEach` in `.storybook/vitest.setup.ts` skips them (no snapshots) while
 * their `play` functions still run.
 *
 * The TRIGGER is queried through `canvas` (it lives in the story root), but the
 * PANEL is queried through `screen` (the whole document): `Tooltip` portals its
 * panel to `document.body` so an ancestor's `overflow: hidden` can never clip
 * it, which puts the panel outside `canvasElement`. The hidden-state assertions
 * still hold on `screen` because the closed panel is `aria-hidden`, so it is
 * absent from the accessibility tree `*ByRole` searches.
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
      await expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    await step('Hovering the trigger reveals the tooltip', async () => {
      await userEvent.hover(trigger);
      const tip = await screen.findByRole('tooltip');
      await expect(tip).toHaveTextContent(/copied to clipboard/i);
      // The trigger points screen readers at the now-visible panel.
      await expect(trigger.parentElement).toHaveAttribute('aria-describedby');
    });

    await step('Moving away hides the tooltip again', async () => {
      await userEvent.unhover(trigger);
      await expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  },
};

export const EscapeDismissesTooltip: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByRole('button', { name: /copy/i });

    await step('Open the tooltip via hover', async () => {
      await userEvent.hover(trigger);
      const tip = await screen.findByRole('tooltip');
      // The panel enters the a11y tree as soon as it is open, but it stays
      // `opacity-0` for the frame before its measured position lands, so the
      // visibility assertion is polled rather than sampled once.
      await waitFor(() => expect(tip).toBeVisible());
    });

    await step('Escape dismisses it', async () => {
      await userEvent.keyboard('{Escape}');
      await expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  },
};
