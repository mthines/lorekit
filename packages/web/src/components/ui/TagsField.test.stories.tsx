import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';

import { TagsField } from './TagsField';

/**
 * Interaction tests for the tag chips' filter in / filter out flyout — the
 * `/Tests` namespace, tagged `test` and excluded from visual snapshots.
 *
 * The flyout is PORTALED to `document.body`, but React still bubbles its events
 * up the component tree — straight into `TagsField`'s "click anywhere to focus
 * the input" container. These pin that pressing a filter button applies the
 * filter and leaves focus alone, from the mouse and from the keyboard.
 */
const meta: Meta<typeof TagsField> = {
  title: 'UI/TagsField/Tests',
  component: TagsField,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
  args: {
    label: 'Tags',
    tags: ['perf', 'flaky'],
    editable: true,
    onChange: fn(),
    onTagFilter: fn(),
    tagFilterState: () => null,
  },
};

export default meta;
type Story = StoryObj<typeof TagsField>;

export const FilterButtonDoesNotFocusTheInput: Story = {
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('textbox');

    await step('hovering a chip reveals its filter in / filter out flyout', async () => {
      await userEvent.hover(canvas.getByRole('button', { name: /^tag "perf"/ }));
      const filterOut = await screen.findByRole('button', { name: 'Filter out — hide memories with tag "perf"' });
      const flyout = filterOut.closest('[data-testid="filterable-meta-value-flyout"]');
      await waitFor(() => expect(flyout).toHaveClass('opacity-100'));
    });

    await step('pressing filter out applies it without moving focus into the input', async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Filter out — hide memories with tag "perf"' }));
      await expect(args.onTagFilter).toHaveBeenCalledWith('perf', 'exclude');
      await expect(input).not.toHaveFocus();
    });
  },
};

export const KeyboardFiltersFromTheChip: Story = {
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole('button', { name: /^tag "flaky"/ });

    await step('Enter filters in and Shift+Enter filters out, focus staying on the chip', async () => {
      chip.focus();
      await userEvent.keyboard('{Enter}');
      await expect(args.onTagFilter).toHaveBeenLastCalledWith('flaky', 'include');
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
      await expect(args.onTagFilter).toHaveBeenLastCalledWith('flaky', 'exclude');
      await expect(chip).toHaveFocus();
    });
  },
};
