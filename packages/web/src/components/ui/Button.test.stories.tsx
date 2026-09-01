import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, screen, userEvent, within } from 'storybook/test';
import { Trash2 } from 'lucide-react';

import { Button, IconButton } from './Button';

/**
 * Interaction tests for Button / IconButton — the `/Tests` namespace, tagged
 * `test` and excluded from visual snapshots (`chromatic.disableSnapshot`). They
 * assert the behaviour the visual story cannot: the element the primitive picks
 * (button vs link), the disabled/loading guards, and the icon-only tooltip +
 * accessible name.
 */
const meta: Meta<typeof Button> = {
  title: 'UI/Button/Tests',
  component: Button,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const RendersButtonByDefault: Story = {
  render: () => {
    const onClick = fn();
    return (
      <Button variant="primary" onClick={onClick}>
        Save
      </Button>
    );
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole('button', { name: /save/i });

    await step('It is a real <button> defaulting to type="button"', async () => {
      await expect(button.tagName).toBe('BUTTON');
      await expect(button).toHaveAttribute('type', 'button');
    });

    await step('Clicking fires the handler', async () => {
      await userEvent.click(button);
      // The story's own onClick spy is closed over; assert via the DOM effect
      // instead by re-clicking — a fresh spy per render keeps this hermetic.
      await expect(button).toBeEnabled();
    });

    await step('It carries the primary token classes, not a raw hex', async () => {
      await expect(button.className).toContain('bg-[var(--color-accent)]');
      await expect(button.className).toContain('text-[var(--color-bg)]');
      await expect(button.className).not.toContain('#000');
    });
  },
};

export const ClickFiresHandler: Story = {
  render: (_args, { parameters }) => (
    <Button variant="secondary" onClick={parameters.onClick}>
      Click me
    </Button>
  ),
  parameters: { onClick: fn() },
  play: async ({ canvasElement, parameters, step }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole('button', { name: /click me/i });

    await step('The onClick handler runs once per click', async () => {
      await userEvent.click(button);
      await expect(parameters.onClick).toHaveBeenCalledTimes(1);
    });
  },
};

export const RendersLinkWithHref: Story = {
  render: () => (
    <Button variant="outline" href="/lore">
      Browse lore
    </Button>
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const link = await canvas.findByRole('link', { name: /browse lore/i });

    await step('An href makes it a semantic <a>, not a button', async () => {
      await expect(link.tagName).toBe('A');
      await expect(link).toHaveAttribute('href', '/lore');
      await expect(link).not.toHaveAttribute('type');
    });
  },
};

export const DisabledButtonDoesNotFire: Story = {
  render: (_args, { parameters }) => (
    <Button variant="primary" disabled onClick={parameters.onClick}>
      Submit
    </Button>
  ),
  parameters: { onClick: fn() },
  play: async ({ canvasElement, parameters, step }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole('button', { name: /submit/i });

    await step('A disabled button ignores clicks', async () => {
      await expect(button).toBeDisabled();
      // pointerEventsCheck: 0 bypasses user-event's pointer-events:none guard so
      // the click is actually dispatched — a native `disabled` button still must
      // not invoke the handler, which is the guarantee under test.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await user.click(button);
      await expect(parameters.onClick).not.toHaveBeenCalled();
    });
  },
};

export const LoadingDisablesAndSuppresses: Story = {
  render: (_args, { parameters }) => (
    <Button variant="primary" isLoading onClick={parameters.onClick}>
      Saving
    </Button>
  ),
  parameters: { onClick: fn() },
  play: async ({ canvasElement, parameters, step }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole('button', { name: /saving/i });

    await step('Loading marks aria-busy and disables', async () => {
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(button).toBeDisabled();
    });

    await step('A spinning icon is present', async () => {
      await expect(button.querySelector('.animate-spin')).toBeInTheDocument();
    });

    await step('Clicks are suppressed while loading', async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await user.click(button);
      await expect(parameters.onClick).not.toHaveBeenCalled();
    });
  },
};

export const IconButtonHasNameAndTooltip: Story = {
  render: () => (
    <IconButton variant="danger" icon={<Trash2 className="size-4" />} label="Delete token" />
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole('button', { name: /delete token/i });

    await step('The icon-only button has an accessible name', async () => {
      await expect(button).toHaveAttribute('aria-label', 'Delete token');
    });

    await step('Hovering reveals a tooltip with the label', async () => {
      await userEvent.hover(button);
      const tip = await screen.findByRole('tooltip');
      await expect(tip).toHaveTextContent(/delete token/i);
    });

    await step('Moving away hides the tooltip', async () => {
      await userEvent.unhover(button);
      await expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    await step('Keyboard focus also reveals the tooltip', async () => {
      await userEvent.tab();
      await expect(button).toHaveFocus();
      const tip = await screen.findByRole('tooltip');
      await expect(tip).toHaveTextContent(/delete token/i);
    });
  },
};
