import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { FilterMenu } from './FilterMenu';
import { FilterPillRow } from './FilterBar';
import { FACETS } from './filter-fixtures';
import { ListMemoriesBodySchema } from '@lorekit/schemas/memory';
import {
  FILTER_FIELDS,
  filtersToBody,
  removeFilter,
  setFilterOperator,
  toggleFilterValue,
  type Filter,
  type FilterField,
} from '@/lib/filters';
import {
  RETENTION_FIELDS,
  type RetentionConditions,
  type RetentionField,
} from '@/lib/retention-filter';

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
 * The desktop popover is PORTALED to `document.body` (it has to be — in flow it
 * was clipped by the Explorer's `overflow-hidden` panels), so menu queries run
 * against the document, not the story canvas. `openMenu` returns that scope;
 * pills are inside the canvas but resolve from the document too.
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
  // The trigger relabels itself once a condition is committed ("Add filter" →
  // "Filters: n applied. Add or edit a filter"), so a story that reopens the
  // menu after committing a pill needs both spellings.
  const trigger = await within(canvasElement).findByRole('button', {
    name: /add (?:or edit a )?filter/i,
  });
  await userEvent.click(trigger);
  // The popover lives outside `canvasElement` now — scope to the document.
  const screen = within(document.body);
  await screen.findByRole('dialog', { name: /^filter$/i });
  return screen;
}

export const ListsEveryDimensionFirst: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);

    await step('level one is the dimension list, not a value list', async () => {
      const rows = canvas.getAllByRole('option');
      // Counted from FILTER_FIELDS rather than a literal, so adding a dimension
      // extends this test instead of breaking it — the ends stay pinned as
      // literals because menu ORDER is a deliberate design decision, not an
      // artefact of the array.
      await expect(rows).toHaveLength(FILTER_FIELDS.length);
      await expect(rows[0]).toHaveTextContent('Label');
      await expect(rows[rows.length - 1]).toHaveTextContent('Pull request');
    });

    await step('the taxonomy pair sits together, high in the list', async () => {
      // Kind partitions the store most coarsely (a `bus` event is not what
      // someone browsing lessons means to read) and Host is the phrase's other
      // half — `kind=lesson & host=reviewer` is "reviewer's lessons".
      const rows = canvas.getAllByRole('option');
      await expect(rows[1]).toHaveTextContent('Kind');
      await expect(rows[2]).toHaveTextContent('Host');
    });

    await step('the listbox announces itself as the dimension chooser', async () => {
      await expect(canvas.getByRole('listbox', { name: /filter by/i })).toBeInTheDocument();
    });
  },
};

/**
 * The taxonomy pair, end to end through the UI.
 *
 * `GET /memories` has accepted `kind` / `host` since migration 00056 and the
 * facets route has catalogued them since 00057 — the values were arriving and
 * being dropped for want of a `FILTER_FIELDS` row. This asserts the whole path
 * a user actually takes: the dimension is listed with its counts, drilling in
 * shows the catalog, selecting commits a pill, and the committed bar maps to
 * the query params the route understands.
 *
 * The last step matters most. Every earlier story stops at the pill, which is
 * where the previous gap hid: a dimension can be perfectly navigable and still
 * send nothing.
 */
export const KindAndHostFilterTheTaxonomy: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);

    await step('Kind drills in to its closed vocabulary, with counts', async () => {
      await userEvent.click(canvas.getByRole('option', { name: /kind/i }));
      // The drill-in is a state update, so the value list has to be AWAITED —
      // a sync read here returns the root dimension list that is still mounted.
      // Scoped to the level-two listbox for the same reason: `option` at
      // document scope cannot tell the two levels apart.
      const list = await canvas.findByRole('listbox', { name: /kind values/i });
      const values = within(list).getAllByRole('option');
      await expect(values).toHaveLength(3);
      await expect(values[0]).toHaveTextContent('lesson');
      // Counts come from the facet catalog, ordered count-desc as the RPC emits.
      await expect(values[0]).toHaveTextContent('52');
    });

    await step('selecting a value commits a Kind pill', async () => {
      await userEvent.click(canvas.getByRole('option', { name: /lesson/i }));
      // The pill's own label, as every other story asserts it: a `/Kind/` text
      // match also hits the `aria-live` announcement, and `/lesson/` hits both
      // that and the value segment.
      await expect(await within(canvasElement).findByLabelText('Kind is lesson')).toBeInTheDocument();
    });

    await step('Host is a separate dimension, not a second Agent', async () => {
      // `aw` exists under BOTH host and source_agent, so a menu that conflated
      // them would show one row here and commit the wrong param.
      // A click toggles and STAYS open, so the menu is still on Kind's values:
      // go back a level rather than reopening, which would close it.
      await userEvent.keyboard('{Escape}');
      await canvas.findByRole('listbox', { name: /filter by/i });

      await userEvent.click(canvas.getByRole('option', { name: /^host/i }));
      const list = await canvas.findByRole('listbox', { name: /host values/i });
      const values = within(list).getAllByRole('option');
      await expect(values.map((v) => v.textContent).join(' ')).toContain('reviewer');
      await userEvent.click(within(list).getByRole('option', { name: /reviewer/i }));
    });

    await step('the committed bar maps to the body the route accepts', async () => {
      // The step the earlier stories never take. Asserted against the SCHEMA,
      // not a hand-written string, so a field the route does not accept fails
      // here rather than being dropped silently on the wire. Values are ARRAYS:
      // the body transport never joins them, which is what lets the bar grow
      // past the query string's per-dimension cap.
      const body = filtersToBody([
        { field: 'kind', operator: 'in', values: ['lesson'] },
        { field: 'host', operator: 'in', values: ['reviewer'] },
      ]);
      await expect(body).toEqual({
        kind: ['lesson'],
        kind_mode: 'in',
        host: ['reviewer'],
        host_mode: 'in',
      });
      for (const key of Object.keys(body)) {
        await expect(Object.keys(ListMemoriesBodySchema.shape)).toContain(key);
      }
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

    // Branch is the dimension this story drills into, and its row index moves
    // whenever a dimension is inserted above it (Kind and Host just did). Derive
    // the walk from `FILTER_FIELDS` rather than hardcoding a count, so the story
    // keeps testing the arrow keys instead of the current menu ordering — which
    // `ListsEveryDimensionFirst` is the one to assert.
    const branchIndex = FILTER_FIELDS.findIndex((d) => d.field === 'branch');

    await step('ArrowDown walks dimensions without moving DOM focus', async () => {
      await userEvent.keyboard('{ArrowDown}'.repeat(branchIndex));
      await expect(input).toHaveAttribute(
        'aria-activedescendant',
        `filter-menu-option-${branchIndex}`,
      );
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
    // The value segment reopens the PORTALED menu, so this story needs the
    // document scope; the pills themselves resolve from it too.
    const canvas = within(document.body);

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
    // The listbox is PORTALED to `document.body` (the pill root and the
    // Explorer's panels are all `overflow-hidden`), so it is not a descendant
    // of the canvas — same document scope `PillOperatorAndValueEditing` uses.
    const canvas = within(document.body);

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

/**
 * The dimension list has to say which groups are already doing the filtering.
 *
 * As you apply filters the results list shrinks — which is the point — but the
 * dimension list itself gave no sign of WHERE that narrowing came from, so you
 * could not tell a filtered-on group from an untouched one without opening each.
 * A per-group count badge, folded into the row's accessible name, closes that.
 */
export const DimensionListShowsPerGroupSelectionCount: Story = {
  args: {
    initialFilters: [
      { field: 'label', operator: 'all', values: ['performance', 'auth'] },
      { field: 'agent', operator: 'in', values: ['claude'] },
    ],
  },
  play: async ({ canvasElement, step }) => {
    // The trigger's name changes once a filter is applied ("Add or edit a
    // filter"), so `openMenu`'s /add filter/ query would miss it.
    await userEvent.click(
      await within(canvasElement).findByRole('button', { name: /add or edit a filter/i }),
    );
    const canvas = within(document.body);
    await canvas.findByRole('dialog', { name: /^filter$/i });

    await step('each filtered group announces its selection count', async () => {
      await expect(
        canvas.getByRole('option', { name: /label, 2 selected/i }),
      ).toBeInTheDocument();
      await expect(
        canvas.getByRole('option', { name: /agent, 1 selected/i }),
      ).toBeInTheDocument();
    });

    await step('an untouched group is still just its name — no phantom count', async () => {
      await expect(canvas.getByRole('option', { name: /^trigger$/i })).toBeInTheDocument();
      await expect(
        canvas.queryByRole('option', { name: /trigger,.*selected/i }),
      ).not.toBeInTheDocument();
    });
  },
};

/**
 * Regression: the mobile sheet must not steal focus when you drill in.
 *
 * On a phone, focusing the search box raises the on-screen keyboard, which
 * scrolls the sheet up and off the very values the user just opened. The sheet
 * deliberately never auto-focuses — on open OR on drilling into a dimension —
 * so the keyboard only appears when the user taps the field. (The popover keeps
 * its focus, which is what its keyboard model needs.)
 */
export const MobileSheetDoesNotAutofocusOnDrillIn: StoryObj<typeof MobileHarness> = {
  render: () => <MobileHarness />,
  play: async ({ canvasElement, step }) => {
    const screen = within(document.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: /add filter/i }));

    await step('opening the sheet does not focus the search box', async () => {
      const input = await screen.findByRole('combobox', { name: /search filters/i });
      await expect(input).not.toHaveFocus();
    });

    await step('drilling into a dimension still does not focus it', async () => {
      await userEvent.click(await screen.findByRole('option', { name: /^agent/i }));
      const input = await screen.findByRole('combobox', { name: /search agent values/i });
      await expect(input).not.toHaveFocus();
    });
  },
};

/**
 * Regression: the popover must escape its ancestors' overflow.
 *
 * In the Explorer the trigger sits inside `overflow-hidden` panels and a
 * scrolling results column, so an in-flow `absolute` popover was clipped by the
 * first of them — the menu opened and was simply cut off. The harness here
 * reproduces exactly that shape: a short, clipping, scrolling box around the
 * control.
 */
function ClippedHarness() {
  const [filters, setFilters] = useState<Filter[]>([]);
  return (
    <div
      data-testid="clipping-ancestor"
      // The two properties that did the clipping, at a height that guarantees
      // a 288px-wide, ~300px-tall menu cannot fit inside.
      style={{ width: 420, height: 90, overflow: 'hidden auto', border: '1px solid #333' }}
    >
      <FilterMenu
        facets={FACETS}
        filters={filters}
        onToggleValue={(field, value) => setFilters((f) => toggleFilterValue(f, field, value))}
        variant="desktop"
      />
    </div>
  );
}

export const PopoverEscapesAClippingAncestor: StoryObj<typeof ClippedHarness> = {
  render: () => <ClippedHarness />,
  play: async ({ canvasElement, step }) => {
    const clip = within(canvasElement).getByTestId('clipping-ancestor');
    await userEvent.click(within(canvasElement).getByRole('button', { name: /add filter/i }));

    const popover = await within(document.body).findByTestId('filter-menu-popover');

    await step('the popover is not a descendant of the clipping box', async () => {
      // The assertion the bug would fail: in-flow, the popover was inside this
      // 90px-tall `overflow: hidden` box and therefore invisible below ~54px.
      await expect(clip.contains(popover)).toBe(false);
    });

    await step('nor of ANY element that would clip it', async () => {
      let el: HTMLElement | null = popover.parentElement;
      const clippers: string[] = [];
      while (el && el !== document.body) {
        const overflow = getComputedStyle(el).overflow;
        if (overflow !== 'visible') clippers.push(`${el.tagName}[overflow:${overflow}]`);
        el = el.parentElement;
      }
      await expect(clippers, clippers.join(', ')).toEqual([]);
    });

    await step('it is fully inside the viewport, not spilling off an edge', async () => {
      const box = popover.getBoundingClientRect();
      await expect(box.width).toBeGreaterThan(0);
      await expect(box.height).toBeGreaterThan(0);
      await expect(box.left).toBeGreaterThanOrEqual(0);
      await expect(box.right).toBeLessThanOrEqual(window.innerWidth);
      await expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
    });

    await step('a click on one of its own rows still toggles rather than closing', async () => {
      // The portal is outside the trigger's container, so a naive
      // click-outside check would read this as "outside" and close on the
      // first pick.
      const screen = within(document.body);
      await userEvent.click(await screen.findByRole('option', { name: /^agent/i }));
      await expect(screen.getByRole('dialog', { name: /^filter$/i })).toBeInTheDocument();
      await expect(
        await screen.findByRole('listbox', { name: /agent values/i }),
      ).toBeInTheDocument();
    });
  },
};

/**
 * Regression: the mobile sheet must not resize as you navigate it.
 *
 * A bottom sheet is anchored to the bottom edge, so every row the body gains or
 * loses moves the header, the search box and every row under the user's thumb.
 * Walking from the six-row dimension list into a two-value dimension resized
 * the whole surface mid-gesture. The list is now bounded to a narrow 45–55vh
 * band, so both levels render at the same height.
 */
function MobileHarness() {
  const [filters, setFilters] = useState<Filter[]>([]);
  return (
    <FilterMenu
      facets={FACETS}
      filters={filters}
      onToggleValue={(field, value) => setFilters((f) => toggleFilterValue(f, field, value))}
      variant="mobile"
    />
  );
}

export const MobileSheetKeepsItsHeightAcrossLevels: StoryObj<typeof MobileHarness> = {
  render: () => <MobileHarness />,
  play: async ({ canvasElement, step }) => {
    const screen = within(document.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: /add filter/i }));

    const sheet = await screen.findByRole('dialog');
    const rootHeight = (await screen.findByRole('listbox', { name: /filter by/i })).clientHeight;
    const sheetHeight = sheet.getBoundingClientRect().height;

    await step('the dimension list is already at the floor, not six rows tall', async () => {
      // Six rows is ~200px; the floor is 45vh. Without it the sheet would open
      // short and then grow or shrink on every level change.
      await expect(rootHeight).toBeGreaterThan(0.4 * window.innerHeight);
    });

    await step('drilling into a two-value dimension does not resize the list', async () => {
      await userEvent.click(await screen.findByRole('option', { name: /^agent/i }));
      const valuesList = await screen.findByRole('listbox', { name: /agent values/i });
      await expect(valuesList.clientHeight).toBe(rootHeight);
    });

    await step('…nor the sheet around it', async () => {
      await waitFor(() =>
        expect(sheet.getBoundingClientRect().height).toBeCloseTo(sheetHeight, 0),
      );
    });

    await step('going back is just as still', async () => {
      await userEvent.click(await screen.findByRole('button', { name: /back to filter types/i }));
      const rootAgain = await screen.findByRole('listbox', { name: /filter by/i });
      await expect(rootAgain.clientHeight).toBe(rootHeight);
    });
  },
};

// ── Age & activity ───────────────────────────────────────────────────────────

/**
 * The same harness with the retention half wired up.
 *
 * Both `retention` and `onRetentionChange` are passed, which is what makes the
 * five threshold rows appear at all — `LoreExplorer` withholds the pair to keep
 * the whole thing behind its flag, and the stories above exercise exactly that
 * withheld state.
 */
function RetentionHarness({
  initialFilters = [] as Filter[],
  initialRetention = {} as RetentionConditions,
}) {
  const [filters, setFilters] = useState<Filter[]>(initialFilters);
  const [retention, setRetention] = useState<RetentionConditions>(initialRetention);
  const [editingField, setEditingField] = useState<FilterField | null>(null);
  const [editingRetentionField, setEditingRetentionField] = useState<RetentionField | null>(null);

  return (
    <div style={{ width: 560, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <FilterMenu
        facets={FACETS}
        filters={filters}
        onToggleValue={(field, value) => setFilters((f) => toggleFilterValue(f, field, value))}
        retention={retention}
        onRetentionChange={setRetention}
        variant="desktop"
        openAtField={editingField}
        onOpenAtFieldHandled={() => setEditingField(null)}
        openAtRetentionField={editingRetentionField}
        onOpenAtRetentionFieldHandled={() => setEditingRetentionField(null)}
      />
      <FilterPillRow
        filters={filters}
        onOperatorChange={(field, op) => setFilters((f) => setFilterOperator(f, field, op))}
        onRemove={(field) => setFilters((f) => removeFilter(f, field))}
        onClearAll={() => setFilters([])}
        onEditField={setEditingField}
        retention={retention}
        onRetentionChange={setRetention}
        onEditRetentionField={setEditingRetentionField}
      />
    </div>
  );
}

/**
 * The thresholds are siblings of the dimensions, not a second surface.
 *
 * The whole point of folding the old `RetentionConditionsControl` in here: one
 * list, one trigger, one answer to "what is narrowing this?". This pins the
 * arrangement — dimensions first, five thresholds after, under a group heading
 * — and that a threshold's rows are the presets rather than a facet catalog.
 */
export const AgeAndActivityRowsSitBelowTheDimensions: StoryObj<typeof RetentionHarness> = {
  render: () => <RetentionHarness />,
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);

    await step('the five thresholds follow the nine dimensions, in order', async () => {
      const rows = canvas.getAllByRole('option');
      await expect(rows).toHaveLength(FILTER_FIELDS.length + RETENTION_FIELDS.length);
      const retentionRows = rows.slice(FILTER_FIELDS.length);
      await expect(retentionRows.map((r) => r.textContent?.trim())).toEqual(
        RETENTION_FIELDS.map((d) => d.label),
      );
    });

    await step('a heading names the group without becoming a row', async () => {
      // It must NOT be an option: `activeIndex` and the option ids are
      // positional, so a non-selectable entry in the array would shift every id
      // past it and give the arrows a row they cannot land on.
      await expect(canvas.getByText(/age & activity/i)).toBeInTheDocument();
      await expect(
        canvas.queryByRole('option', { name: /^age & activity$/i }),
      ).not.toBeInTheDocument();
    });

    await step('drilling into one shows its presets and the rule it tests', async () => {
      await userEvent.click(canvas.getByRole('option', { name: /^chosen$/i }));
      const list = within(await canvas.findByRole('listbox', { name: /chosen values/i }));
      await expect(list.getByRole('option', { name: /never chosen/i })).toBeInTheDocument();
      // The hint is the one thing a bare number cannot carry, and `Delivered`
      // vs `Chosen` is exactly what readers got wrong without it.
      await expect(canvas.getByText(/bulk reads do NOT count/i)).toBeInTheDocument();
    });

    await step('a threshold list is single-select, unlike a dimension', async () => {
      await expect(canvas.getByRole('listbox', { name: /chosen values/i })).not.toHaveAttribute(
        'aria-multiselectable',
      );
    });
  },
};

/**
 * Picking a value applies it and returns to the row list, so conditions chain.
 *
 * The behaviour that separates a threshold from a dimension: a dimension stays
 * on its value list because the next pick is another value of the SAME field; a
 * threshold has no second value, and the next thing a reader wants is a
 * different threshold. Two picks without touching the trigger is the test.
 */
export const PickingAThresholdReturnsToTheRowListSoConditionsChain: StoryObj<
  typeof RetentionHarness
> = {
  render: () => <RetentionHarness />,
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);

    await step('the first pick applies and pops back to level one', async () => {
      await userEvent.click(canvas.getByRole('option', { name: /^created$/i }));
      await userEvent.click(
        within(await canvas.findByRole('listbox', { name: /created values/i })).getByRole(
          'option',
          { name: /more than 30 days ago/i },
        ),
      );
      await waitFor(async () => {
        await expect(canvas.getByRole('listbox', { name: /filter by/i })).toBeInTheDocument();
      });
      // The applied value rides on the row, so the reader can see it without
      // drilling back in.
      await expect(
        canvas.getByRole('option', { name: /created, more than 30 days ago/i }),
      ).toBeInTheDocument();
    });

    await step('a second threshold is two more clicks, with no trip to the trigger', async () => {
      await userEvent.click(canvas.getByRole('option', { name: /^chosen$/i }));
      await userEvent.click(
        within(await canvas.findByRole('listbox', { name: /chosen values/i })).getByRole('option', {
          name: /never chosen/i,
        }),
      );
      await waitFor(async () => {
        await expect(canvas.getByRole('option', { name: /^chosen, never chosen$/i })).toBeInTheDocument();
      });
    });

    await step('both render as pills, in the menu order', async () => {
      // The pill ROOT, not its value segment — that carries the same phrase
      // suffixed with "— change value", so an unfiltered query returns four.
      const pills = within(canvasElement)
        .getAllByLabelText(/^(created|chosen):/i)
        .filter((el) => el.tagName === 'DIV');
      await expect(pills.map((p) => p.getAttribute('aria-label'))).toEqual([
        'Created: More than 30 days ago',
        'Chosen: Never chosen',
      ]);
    });
  },
};

/**
 * The search box IS the custom-value input.
 *
 * A threshold's value space is every integer in range, so there is no facet
 * catalog to search and a "Custom…" row could only ever open a text field the
 * menu already has. Typing offers the value; typing something illegal says so
 * rather than applying a threshold that `normalizeRetentionConditions` would
 * silently drop on the next read of the URL.
 */
export const TypingAValueOffersItAsACustomThreshold: StoryObj<typeof RetentionHarness> = {
  render: () => <RetentionHarness />,
  play: async ({ canvasElement, step }) => {
    const canvas = await openMenu(canvasElement);
    await userEvent.click(canvas.getByRole('option', { name: /^created$/i }));
    const input = await canvas.findByRole('combobox', { name: /search created values/i });

    await step('a legal number leads the list, labelled custom', async () => {
      await userEvent.type(input, '45');
      const rows = within(
        await canvas.findByRole('listbox', { name: /created values/i }),
      ).getAllByRole('option');
      await expect(rows).toHaveLength(1);
      await expect(rows[0]).toHaveTextContent(/more than 45 days ago/i);
      await expect(rows[0]).toHaveTextContent(/custom/i);
    });

    await step('applying it commits the typed value', async () => {
      await userEvent.keyboard('{Enter}');
      await waitFor(async () => {
        await expect(
          within(canvasElement).getByLabelText('Created: More than 45 days ago'),
        ).toBeInTheDocument();
      });
    });

    await step('an out-of-bounds value is refused, with its range named', async () => {
      // `find`, not `get`: the commit above pops back to level one through a
      // state update, so the row carrying the applied value arrives a tick later.
      await userEvent.click(await canvas.findByRole('option', { name: /^created,/i }));
      await userEvent.type(
        await canvas.findByRole('combobox', { name: /search created values/i }),
        '9999',
      );
      await expect(await canvas.findByText(/is not a value here/i)).toHaveTextContent(/3650/);
    });
  },
};

/**
 * A threshold pill behaves like a dimension pill: edit through the value
 * segment, clear through the ×.
 *
 * It has three segments rather than four — no operator, because a threshold's
 * comparison is baked into the condition (`max_opened_count` is always "at
 * most") and the value's own wording carries it.
 */
export const RetentionPillEditsAndClears: StoryObj<typeof RetentionHarness> = {
  render: () => <RetentionHarness initialRetention={{ minAgeDays: 30 }} />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const screen = within(document.body);

    await step('the pill has no operator segment', async () => {
      const pill = canvas.getByLabelText('Created: More than 30 days ago');
      await expect(within(pill).getAllByRole('button')).toHaveLength(2);
    });

    await step('the value segment reopens the menu at that threshold', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /change value/i }));
      await expect(await screen.findByRole('listbox', { name: /created values/i })).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
    });

    await step('choosing the value already in force clears it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /change value/i }));
      await userEvent.click(
        within(await screen.findByRole('listbox', { name: /created values/i })).getByRole('option', {
          name: /more than 30 days ago/i,
        }),
      );
      await waitFor(async () => {
        await expect(
          canvas.queryByLabelText('Created: More than 30 days ago'),
        ).not.toBeInTheDocument();
      });
    });
  },
};

/**
 * Reopening a condition set to a TYPED value shows that value, selected.
 *
 * The presets are five round numbers; the search box lets a reader apply any
 * legal integer. So the value in force is regularly one the preset list does not
 * contain, and a list that shows only presets then contradicts the pill sitting
 * beside it — five rows, none of them selected, for a condition the bar says is
 * applied. The applied value gets a row of its own, leading and labelled custom.
 */
export const AnAppliedCustomValueIsShownSelected: StoryObj<typeof RetentionHarness> = {
  render: () => <RetentionHarness initialRetention={{ minAgeDays: 5 }} />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const screen = within(document.body);

    await step('the bar shows the typed threshold', async () => {
      await expect(canvas.getByLabelText('Created: More than 5 days ago')).toBeInTheDocument();
    });

    await step('reopening the condition leads with that value, selected', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /change value/i }));
      const list = await screen.findByRole('listbox', { name: /created values/i });
      const options = within(list).getAllByRole('option');

      // Leading, so the state the reader came to change is the first thing there.
      await expect(options[0]).toHaveAccessibleName(/more than 5 days ago/i);
      await expect(options[0]).toHaveAttribute('aria-selected', 'true');
      await expect(within(options[0]!).getByText('custom')).toBeInTheDocument();

      // And it is an ADDITION — every preset is still reachable underneath it.
      await expect(options).toHaveLength(6);
      await expect(options[1]).toHaveAccessibleName(/more than 7 days ago/i);
    });
  },
};

/**
 * "Create retention policy" is offered only when there is somewhere to send it.
 *
 * `LoreExplorer` omits `onCreatePolicy` while the `retention-policies` flag is
 * off, because its destination (`/settings/grooming`) 404s there — the action
 * disappears rather than dead-ending.
 */
export const CreatePolicyActionFollowsItsDestination: StoryObj<typeof FilterPillRow> = {
  render: (args) => <FilterPillRow {...args} />,
  args: {
    filters: [{ field: 'label', operator: 'in', values: ['performance'] }],
    onOperatorChange: fn(),
    onRemove: fn(),
    onClearAll: fn(),
    onEditField: fn(),
    retention: { maxOpenedCount: 0 },
    onRetentionChange: fn(),
    onEditRetentionField: fn(),
  },
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('without a destination the action is absent', async () => {
      await expect(
        canvas.queryByRole('button', { name: /create retention policy/i }),
      ).not.toBeInTheDocument();
    });

    await step('a dimension pill and a threshold pill share one row', async () => {
      // Exact names: each pill's value segment repeats its phrase with a
      // "— change value" suffix, so a prefix match returns two per pill.
      await expect(canvas.getByLabelText('Label includes any performance')).toBeInTheDocument();
      await expect(canvas.getByLabelText('Chosen: Never chosen')).toBeInTheDocument();
    });

    await step('one "Clear all" clears both halves of the bar', async () => {
      // A single button, two callbacks. Wiring it to `onClearAll` alone is the
      // obvious bug and leaves the thresholds behind on a bar that says it is
      // empty.
      await userEvent.click(canvas.getByRole('button', { name: /clear all/i }));
      await expect(args.onClearAll).toHaveBeenCalled();
      await expect(args.onRetentionChange).toHaveBeenCalledWith({});
    });
  },
};

/**
 * The action appears once there is a destination for it.
 */
export const CreatePolicyActionIsOfferedWhenItCanLand: StoryObj<typeof FilterPillRow> = {
  render: (args) => <FilterPillRow {...args} />,
  args: {
    ...CreatePolicyActionFollowsItsDestination.args,
    onCreatePolicy: fn(),
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: /create retention policy/i }),
    );
    await expect(args.onCreatePolicy).toHaveBeenCalled();
  },
};
