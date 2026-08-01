import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { LabelFilter } from './LabelFilter';
import type { TagCount } from '@/lib/tag-filter';

/**
 * Interaction tests for {@link LabelFilter} — the WAI-ARIA combobox model
 * (type-to-filter, arrow-walk via `aria-activedescendant`, Enter-toggle) and
 * the two dismissal/clear behaviours that regressed in review: Escape closing
 * even when focus has moved onto an option button, and the clear affordance
 * being a real, keyboard-operable button rather than a nested span.
 *
 * The desktop popover renders in-flow (not portaled), so it is queried against
 * the story canvas.
 */

const CATALOG: TagCount[] = [
  { tag: 'performance', count: 24 },
  { tag: 'auth', count: 18 },
  { tag: 'database', count: 12 },
  { tag: 'ui', count: 9 },
  { tag: 'testing', count: 7 },
];

/** Controlled wrapper so toggling a label is reflected back into the UI. */
function Harness({ initialSelected = [] as string[] }) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  return (
    <LabelFilter
      catalog={CATALOG}
      selected={selected}
      onToggle={(tag) =>
        setSelected((s) => (s.includes(tag) ? s.filter((t) => t !== tag) : [...s, tag]))
      }
      onClear={() => setSelected([])}
      variant="desktop"
    />
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Lore/LabelFilter/Tests',
  component: Harness,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof Harness>;

async function openPopover(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const trigger = await canvas.findByRole('button', { name: /filter by label/i });
  await userEvent.click(trigger);
  await canvas.findByRole('dialog', { name: /filter by label/i });
  return canvas;
}

export const FiltersAsYouType: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openPopover(canvasElement);

    await step('every label is listed at rest', async () => {
      await expect(canvas.getAllByRole('option')).toHaveLength(CATALOG.length);
    });

    await step('typing narrows the listbox to the substring match', async () => {
      await userEvent.type(canvas.getByRole('combobox', { name: /search labels/i }), 'au');
      await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(1));
      await expect(canvas.getByRole('option')).toHaveTextContent('auth');
    });
  },
};

export const ArrowWalkAndEnterToggles: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openPopover(canvasElement);
    const search = canvas.getByRole('combobox', { name: /search labels/i });

    await step('the active option starts on the first row', async () => {
      await expect(search).toHaveAttribute('aria-activedescendant', 'label-filter-option-0');
    });

    await step('ArrowDown walks the active option without leaving the input', async () => {
      await userEvent.keyboard('{ArrowDown}');
      await expect(search).toHaveAttribute('aria-activedescendant', 'label-filter-option-1');
      await expect(search).toHaveFocus();
    });

    await step('Enter toggles the active option and keeps the popover open', async () => {
      await userEvent.keyboard('{Enter}');
      const auth = await canvas.findByRole('option', { name: /auth/i });
      await expect(auth).toHaveAttribute('aria-selected', 'true');
      await expect(canvas.getByRole('dialog')).toBeInTheDocument();
    });
  },
};

export const EscapeClosesEvenFromAnOption: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openPopover(canvasElement);

    await step('clicking an option moves focus onto that option button', async () => {
      const option = await canvas.findByRole('option', { name: /performance/i });
      await userEvent.click(option);
      await expect(canvas.getByRole('dialog')).toBeInTheDocument();
    });

    await step('Escape closes the popover without leaking to document listeners', async () => {
      // A sibling document-level Escape listener (e.g. LessonDetailSheet's)
      // must NOT fire — the container handler stops propagation. This guards the
      // regression where one Escape closed both the popover and an open lesson.
      const docEscape = fn();
      const onDocKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') docEscape();
      };
      document.addEventListener('keydown', onDocKey);
      try {
        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
        await expect(docEscape).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener('keydown', onDocKey);
      }
    });
  },
};

export const ClearButtonIsKeyboardOperable: Story = {
  args: { initialSelected: ['auth'] },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('an active filter exposes a real clear button', async () => {
      const clear = await canvas.findByRole('button', { name: /clear label filter/i });
      // Space must activate it — a role="button" span would scroll the page instead.
      clear.focus();
      await expect(clear).toHaveFocus();
      await userEvent.keyboard(' ');
    });

    await step('clearing removes the filter and the button', async () => {
      await waitFor(() =>
        expect(canvas.queryByRole('button', { name: /clear label filter/i })).not.toBeInTheDocument(),
      );
    });
  },
};
