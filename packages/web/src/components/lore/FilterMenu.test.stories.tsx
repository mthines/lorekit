import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { FilterMenu } from './FilterMenu';
import { FilterPillRow } from './FilterBar';
import { FACETS } from './filter-fixtures';
import {
  removeFilter,
  setFilterOperator,
  toggleFilterValue,
  type Filter,
  type FilterField,
} from '@/lib/filters';

/**
 * Interaction tests for the Lore Explorer's filter surface.
 *
 * These cover the parts a screenshot cannot: the two-level navigation, the
 * split between Space (toggle, stay) and Enter (toggle, close), the
 * cross-dimension type-ahead that lets an expert skip level one entirely, the
 * three-segment pill's editing model, and the two dismissal behaviours the old
 * `LabelFilter` had to grow the hard way — staged Escape, and an Escape that
 * does not leak to a sibling document listener.
 *
 * The desktop popover renders in-flow (not portaled), so it is queried against
 * the story canvas.
 */

/** Controlled wrapper: the bar is real state, so a toggle is visible in the UI. */
function Harness({ initialFilters = [] as Filter[] }) {
  const [filters, setFilters] = useState<Filter[]>(initialFilters);
  const [editingField, setEditingField] = useState<FilterField | null>(null);

  return (
    <div style={{ width: 560, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <FilterMenu
        facets={FACETS}
        filters={filters}
        onToggleValue={(field, value) => setFilters((f) => toggleFilterValue(f, field, value))}
        variant="desktop"
        openAtField={editingField}
        onOpenAtFieldHandled={() => setEditingField(null)}
      />
      <FilterPillRow
        filters={filters}
        onOperatorChange={(field, op) => setFilters((f) => setFilterOperator(f, field, op))}
        onRemove={(field) => setFilters((f) => removeFilter(f, field))}
        onClearAll={() => setFilters([])}
        onEditField={setEditingField}
      />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Lore/FilterMenu/Tests',
  component: Harness,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof Harness>;

async function openMenu(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const trigger = await canvas.findByRole('button', { name: /add filter/i });
  await userEvent.click(trigger);
  await canvas.findByRole('dialog', { name: /^filter$/i });
  return canvas;
}

export const ListsEveryDimensionFirst: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);

    await step('level one is the dimension list, not a value list', async () => {
      const rows = canvas.getAllByRole('option');
      await expect(rows).toHaveLength(6);
      await expect(rows[0]).toHaveTextContent('Label');
      await expect(rows[5]).toHaveTextContent('Pull request');
    });

    await step('the listbox announces itself as the dimension chooser', async () => {
      await expect(canvas.getByRole('listbox', { name: /filter by/i })).toBeInTheDocument();
    });
  },
};

export const ArrowRightDrillsInAndArrowLeftGoesBack: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);
    const input = canvas.getByRole('combobox', { name: /search filters/i });

    await step('the active row starts on the first dimension', async () => {
      await expect(input).toHaveAttribute('aria-activedescendant', 'filter-menu-option-0');
    });

    await step('ArrowDown walks dimensions without moving DOM focus', async () => {
      await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
      await expect(input).toHaveAttribute('aria-activedescendant', 'filter-menu-option-4');
      await expect(input).toHaveFocus();
    });

    await step('ArrowRight drills into the active dimension', async () => {
      await userEvent.keyboard('{ArrowRight}');
      await expect(
        await canvas.findByRole('listbox', { name: /branch values/i }),
      ).toBeInTheDocument();
      await expect(canvas.getByRole('option', { name: /^main\b/i })).toBeInTheDocument();
    });

    await step('the value list is multi-selectable, the dimension list was not', async () => {
      await expect(canvas.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
    });

    await step('ArrowLeft at the start of an empty query goes back', async () => {
      await userEvent.keyboard('{ArrowLeft}');
      await expect(
        await canvas.findByRole('listbox', { name: /filter by/i }),
      ).toBeInTheDocument();
    });
  },
};

export const SpaceTogglesAndKeepsOpenEnterAppliesAndCloses: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);

    await step('drill into Branch', async () => {
      await userEvent.click(await canvas.findByRole('option', { name: /^branch/i }));
      await canvas.findByRole('listbox', { name: /branch values/i });
    });

    await step('Space toggles the active value and the menu stays open', async () => {
      await userEvent.keyboard(' ');
      await expect(await canvas.findByRole('option', { name: /^main\b/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(canvas.getByRole('dialog')).toBeInTheDocument();
    });

    await step('the committed condition appears as a pill immediately', async () => {
      // Applied as you go — there is no Apply button, so the pill IS the receipt.
      await expect(await canvas.findByLabelText('Branch is main')).toBeInTheDocument();
    });

    await step('Space on a second value widens the condition to "is either of"', async () => {
      await userEvent.keyboard('{ArrowDown} ');
      await waitFor(() =>
        expect(
          canvas.getByLabelText('Branch is either of main, feat/explorer-filters'),
        ).toBeInTheDocument(),
      );
      await expect(canvas.getByRole('dialog')).toBeInTheDocument();
    });

    await step('Enter toggles the active value and closes', async () => {
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
      // The Enter also toggled — it commits a decision, it does not merely dismiss.
      await expect(canvas.getByLabelText('Branch is main')).toBeInTheDocument();
    });
  },
};

export const TypeAheadCommitsAValueWithoutChoosingItsDimension: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);
    const input = canvas.getByRole('combobox', { name: /search filters/i });

    await step('typing at level one surfaces values from every dimension', async () => {
      await userEvent.type(input, 'retro');
      const row = await canvas.findByRole('option', { name: /trigger.*retrospective/i });
      await expect(row).toBeInTheDocument();
    });

    await step('Enter on a qualified value row commits the whole condition and closes', async () => {
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
      await expect(canvas.getByLabelText('Trigger is retrospective')).toBeInTheDocument();
    });
  },
};

export const BackspaceAndStagedEscape: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);

    await step('drill into Label and type a query', async () => {
      await userEvent.click(await canvas.findByRole('option', { name: /^label/i }));
      await userEvent.type(
        canvas.getByRole('combobox', { name: /search label values/i }),
        'auth',
      );
      await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(1));
    });

    await step('Escape clears the query first, keeping the level and the results', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(canvas.getAllByRole('option').length).toBeGreaterThan(1));
      await expect(canvas.getByRole('listbox', { name: /label values/i })).toBeInTheDocument();
    });

    await step('Backspace on an empty query pops back to the dimension list', async () => {
      await userEvent.keyboard('{Backspace}');
      await expect(
        await canvas.findByRole('listbox', { name: /filter by/i }),
      ).toBeInTheDocument();
    });

    await step('Escape at the root closes, without leaking to document listeners', async () => {
      // A sibling document-level Escape listener (LessonDetailSheet's) must NOT
      // fire — one Escape must not both close this menu and an open lesson.
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

export const PillOperatorAndValueEditing: Story = {
  args: {
    initialFilters: [{ field: 'label', operator: 'all', values: ['performance', 'auth'] }],
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a set-valued dimension gets its own operator vocabulary', async () => {
      const operator = await canvas.findByRole('button', {
        name: /label includes all — change operator/i,
      });
      await userEvent.click(operator);
      const menu = await canvas.findByRole('listbox', { name: /label operator/i });
      await expect(within(menu).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'includes all',
        'includes any',
        'includes none',
      ]);
    });

    await step('choosing an operator rewrites the pill in place', async () => {
      await userEvent.click(canvas.getByRole('option', { name: 'includes none' }));
      await waitFor(() =>
        expect(canvas.getByLabelText('Label includes none performance, auth')).toBeInTheDocument(),
      );
    });

    await step('the value segment reopens the menu at that dimension, values pre-checked', async () => {
      await userEvent.click(
        canvas.getByRole('button', { name: /change values/i }),
      );
      await canvas.findByRole('listbox', { name: /label values/i });
      await expect(await canvas.findByRole('option', { name: /performance/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    await step('Escape from a menu opened at level two closes it, never revealing level one', async () => {
      // The user entered at depth 1 from the pill, so "back" from there is
      // "closed" — surfacing a dimension list they never asked for would be a
      // level they did not navigate into.
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
    });
  },
};

export const RemovingAndClearingFilters: Story = {
  args: {
    initialFilters: [
      { field: 'label', operator: 'all', values: ['performance'] },
      { field: 'agent', operator: 'in', values: ['claude'] },
    ],
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the type segment is inert — it is text, not a control', async () => {
      const typeSegments = canvas.queryAllByRole('button', { name: /^label$/i });
      await expect(typeSegments).toHaveLength(0);
    });

    await step('a pill × removes only that condition', async () => {
      await userEvent.click(
        await canvas.findByRole('button', { name: /remove filter: agent is claude/i }),
      );
      await waitFor(() =>
        expect(canvas.queryByLabelText('Agent is claude')).not.toBeInTheDocument(),
      );
      await expect(canvas.getByLabelText('Label includes all performance')).toBeInTheDocument();
    });

    await step('"Clear all" only exists while more than one condition does', async () => {
      await expect(canvas.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
    });
  },
};

/**
 * The pill's operator listbox owns the SAME two guarantees `FilterMenu`'s
 * container does — an Escape that does not leak to a sibling document listener,
 * and focus put back where the list was opened from. `BackspaceAndStagedEscape`
 * covers them for the menu; this covers them for the listbox, which until now
 * was only ever driven by mouse.
 */
export const PillOperatorEscapeDismissesWithoutLeaking: Story = {
  args: {
    initialFilters: [{ field: 'label', operator: 'all', values: ['performance'] }],
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    const trigger = await canvas.findByRole('button', {
      name: /label includes all — change operator/i,
    });

    await step('the operator segment opens its listbox', async () => {
      await userEvent.click(trigger);
      await expect(
        await canvas.findByRole('listbox', { name: /label operator/i }),
      ).toBeInTheDocument();
    });

    await step('Escape closes it without reaching a document listener', async () => {
      // LessonDetailSheet listens for Escape on `document`. One Escape must not
      // both dismiss this listbox and close an open lesson behind the bar.
      const docEscape = fn();
      const onDocKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') docEscape();
      };
      document.addEventListener('keydown', onDocKey);
      try {
        await userEvent.keyboard('{Escape}');
        await waitFor(() =>
          expect(canvas.queryByRole('listbox', { name: /label operator/i })).not.toBeInTheDocument(),
        );
        await expect(docEscape).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener('keydown', onDocKey);
      }
    });

    await step('focus goes back to the trigger, never to <body>', async () => {
      await expect(trigger).toHaveFocus();
    });

    await step('the condition itself is untouched by the dismissal', async () => {
      await expect(canvas.getByLabelText('Label includes all performance')).toBeInTheDocument();
    });
  },
};
