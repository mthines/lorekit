import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { Archive, BookOpen, Clock } from 'lucide-react';

import { Combobox, type ComboboxItem } from './Combobox';

/**
 * Interaction tests for the shared popup selection list, both modes.
 *
 * These cover the parts a screenshot cannot: the keyboard model, the fact that
 * the list opens ON the current value, filtering, and the two dismissal paths.
 * The arithmetic behind all of it (wrapping, skipping disabled options,
 * re-homing a highlight after a filter) is unit-tested in `combobox-logic.spec.ts`;
 * what is asserted here is that the component is actually wired to it.
 *
 * The popover is PORTALED to `document.body`, so its rows resolve against the
 * document rather than the story canvas.
 */
const OPTIONS: ComboboxItem[] = [
  { value: 'active', label: 'Active', hint: 'Live memories', icon: BookOpen },
  { value: 'archived', label: 'Archived', hint: 'Archived memories', icon: Archive },
  { value: 'expiring', label: 'Expiring', hint: 'Live memories expiring within 7 days', icon: Clock },
  { value: 'purged', label: 'Purged', hint: 'Not available yet', disabled: true },
];

function Harness({ initial = 'active', searchable = false }) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ width: 420, padding: '1rem' }}>
      <Combobox
        options={OPTIONS}
        value={value}
        onChange={setValue}
        label="Status"
        searchable={searchable}
      />
      <output data-testid="value" style={{ display: 'block', marginTop: '0.75rem' }}>
        {value}
      </output>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'UI/Combobox/Tests',
  component: Harness,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof Harness>;

async function open(canvasElement: HTMLElement) {
  await userEvent.click(await within(canvasElement).findByRole('button', { name: /^Status:/ }));
  const screen = within(document.body);
  await screen.findByRole('listbox', { name: /status/i });
  return screen;
}

export const OpensOnTheCurrentValue: Story = {
  args: { initial: 'expiring' },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the trigger shows the current selection before opening', async () => {
      await expect(canvas.getByRole('button', { name: /^Status: Expiring/ })).toBeInTheDocument();
    });

    const menu = await open(canvasElement);

    await step('the list marks it selected', async () => {
      await expect(menu.getByRole('option', { name: /Expiring/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    await step('and the highlight starts there, not at the top', async () => {
      // So the list opens showing what you have, and one Down moves to the
      // neighbour — what a native select does.
      const trigger = canvas.getByRole('button', { name: /^Status:/ });
      const active = trigger.getAttribute('aria-activedescendant');
      await expect(document.getElementById(active ?? '')).toHaveTextContent('Expiring');
    });

    await step('the listbox OMITS aria-multiselectable in this mode', async () => {
      // The half `Combobox.tsx` argues for, and the counterpart of
      // `MultiplePicksAccumulateWithoutClosing`'s `'true'` assertion: absent,
      // not present-and-`false`. A `false` reads as a control that COULD take
      // several and does not, which is the noise the conditional spread exists
      // to remove — and asserting a value cannot tell absent from `false`, so
      // assert absence.
      await expect(menu.getByRole('listbox', { name: /status/i })).not.toHaveAttribute(
        'aria-multiselectable',
      );
    });
  },
};

export const KeyboardSelectsWithoutLeavingTheTrigger: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: /^Status:/ });

    await step('ArrowDown opens the list', async () => {
      trigger.focus();
      await userEvent.keyboard('{ArrowDown}');
      await within(document.body).findByRole('listbox', { name: /status/i });
    });

    await step('DOM focus stays on the trigger — the highlight travels by aria', async () => {
      // Losing focus into the list is what breaks Escape and click-outside, and
      // it is the usual bug in a hand-rolled listbox.
      await expect(document.activeElement).toBe(trigger);
    });

    await step('ArrowUp from the top wraps to the LAST selectable option', async () => {
      // `Purged` is disabled, so the wrap must land on `Expiring` — the case
      // that catches both the wrap and the skip in one keystroke.
      await userEvent.keyboard('{ArrowUp}');
      const active = trigger.getAttribute('aria-activedescendant');
      await expect(document.getElementById(active ?? '')).toHaveTextContent('Expiring');
    });

    await step('Enter commits and closes', async () => {
      await userEvent.keyboard('{Enter}');
      await waitFor(async () => {
        await expect(canvas.getByTestId('value')).toHaveTextContent('expiring');
      });
      // The popover unmounts through an exit animation, so the listbox lingers a
      // frame after the commit — wait it out rather than racing it (as the
      // dismissal steps below do).
      await waitFor(async () => {
        await expect(within(document.body).queryByRole('listbox', { name: /status/i })).toBeNull();
      });
    });

    await step('and focus comes back to the trigger', async () => {
      await expect(document.activeElement).toBe(canvas.getByRole('button', { name: /^Status:/ }));
    });
  },
};

export const ADisabledOptionIsVisibleButUnselectable: Story = {
  play: async ({ canvasElement, step }) => {
    const menu = await open(canvasElement);
    const canvas = within(canvasElement);

    await step('it is listed — its absence would look like a missing feature', async () => {
      await expect(menu.getByRole('option', { name: /Purged/ })).toBeInTheDocument();
    });

    await step('committing on it changes nothing and leaves the list open', async () => {
      const purged = menu.getByRole('option', { name: /Purged/ });
      // `userEvent.click` would assert nothing here: the row is a real
      // `disabled` button, so the browser suppresses a user-driven click before
      // it reaches React. Dispatching `pointerup` — the event the row commits
      // on, and one React does NOT withhold from a disabled button — is what
      // puts the `!option.disabled` guard in `onPointerUp` under test.
      fireEvent.pointerUp(purged);
      await expect(canvas.getByTestId('value')).toHaveTextContent('active');
      await expect(menu.getByRole('listbox', { name: /status/i })).toBeInTheDocument();
    });
  },
};

export const SearchFiltersAndRehomesTheHighlight: Story = {
  args: { searchable: true },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const menu = await open(canvasElement);

    await step('the search box takes focus once the popover is measured', async () => {
      // An unmeasured popover renders `visibility: hidden`, and a hidden element
      // silently refuses focus — every keystroke would go to the document.
      await waitFor(async () => {
        await expect(document.activeElement).toBe(
          menu.getByRole('combobox', { name: /search status/i }),
        );
      });
    });

    await step('typing narrows the list', async () => {
      await userEvent.keyboard('arch');
      await waitFor(async () => {
        await expect(menu.getAllByRole('option')).toHaveLength(1);
      });
    });

    await step('it matches the HINT as well as the label', async () => {
      await userEvent.clear(menu.getByRole('combobox', { name: /search status/i }));
      await userEvent.keyboard('7 days');
      await waitFor(async () => {
        await expect(menu.getAllByRole('option')).toHaveLength(1);
        await expect(menu.getByRole('option', { name: /Expiring/ })).toBeInTheDocument();
      });
    });

    await step('the FOCUSED element points at the highlight', async () => {
      // A screen reader reads `aria-activedescendant` off whatever holds DOM
      // focus, and while `searchable` that is this input — not the trigger. On
      // the trigger alone the highlight moved silently in the one shape that
      // has a search box to move it with.
      const search = menu.getByRole('combobox', { name: /search status/i });
      await waitFor(async () => {
        const active = search.getAttribute('aria-activedescendant');
        await expect(active).toBeTruthy();
        await expect(document.getElementById(active as string)).toHaveAttribute('role', 'option');
      });
    });

    await step('Enter selects the re-homed highlight, not a stale index', async () => {
      // Before narrowing, the highlight sat on `Active` at index 0. After it,
      // index 0 is `Expiring` — a stale index would select nothing here.
      await userEvent.keyboard('{Enter}');
      await waitFor(async () => {
        await expect(canvas.getByTestId('value')).toHaveTextContent('expiring');
      });
    });
  },
};

export const EscapeAndClickOutsideBothDismiss: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('Escape closes without committing', async () => {
      const menu = await open(canvasElement);
      await userEvent.keyboard('{ArrowDown}');
      await userEvent.keyboard('{Escape}');
      // Dismissal animates out, so the listbox is removed a frame later — wait
      // for it, mirroring the click-outside step below.
      await waitFor(async () => {
        await expect(menu.queryByRole('listbox', { name: /status/i })).toBeNull();
      });
      // The highlight is not a selection — moving it and bailing must change
      // nothing.
      await expect(canvas.getByTestId('value')).toHaveTextContent('active');
    });

    await step('a click outside closes too', async () => {
      await open(canvasElement);
      await userEvent.click(document.body);
      await waitFor(async () => {
        await expect(within(document.body).queryByRole('listbox', { name: /status/i })).toBeNull();
      });
    });

    await step('a click on a row is NOT outside', async () => {
      // The popover is portaled, so a naive container-only check treats its own
      // rows as outside and closes before the selection lands.
      const menu = await open(canvasElement);
      await userEvent.click(menu.getByRole('option', { name: /Archived/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('value')).toHaveTextContent('archived');
      });
    });
  },
};

/**
 * The multi-select mode's own harness.
 *
 * A second component rather than a flag on `Harness`: the two modes have
 * different `value` types, and threading a union through the harness would put
 * a cast in the test file — exactly where a cast can hide the bug being tested.
 */
function MultiHarness({
  initial = [] as string[],
  searchable = false,
}: {
  initial?: string[];
  searchable?: boolean;
}) {
  const [values, setValues] = useState(initial);
  return (
    <div style={{ width: 420, padding: '1rem' }}>
      <Combobox
        multiple
        options={OPTIONS}
        value={values}
        onChange={setValues}
        label="Statuses"
        countNoun="statuses"
        searchable={searchable}
      />
      <output data-testid="values" style={{ display: 'block', marginTop: '0.75rem' }}>
        {values.join(',')}
      </output>
    </div>
  );
}

async function openMulti(canvasElement: HTMLElement) {
  await userEvent.click(await within(canvasElement).findByRole('button', { name: /^Statuses:/ }));
  const screen = within(document.body);
  await screen.findByRole('listbox', { name: /statuses/i });
  return screen;
}

export const MultiplePicksAccumulateWithoutClosing: Story = {
  render: () => <MultiHarness />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const menu = await openMulti(canvasElement);

    await step('the first pick lands and the list stays open', async () => {
      // The whole point of the mode: building a set of three must not cost
      // three trips to the trigger.
      await userEvent.click(menu.getByRole('option', { name: /Active/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('values')).toHaveTextContent(/^active$/);
      });
      await expect(menu.getByRole('listbox', { name: /statuses/i })).toBeInTheDocument();
    });

    await step('a second pick ADDS rather than replaces', async () => {
      await userEvent.click(menu.getByRole('option', { name: /Archived/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('values')).toHaveTextContent(/^active,archived$/);
      });
    });

    await step('both rows read as selected', async () => {
      await expect(menu.getByRole('option', { name: /Active/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(menu.getByRole('option', { name: /Archived/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    await step('clicking a selected row removes it', async () => {
      // Anchored, not a substring: `toHaveTextContent('archived')` also passes
      // on `active,archived`, so it could not tell the removal from a no-op —
      // the one thing this step exists to prove. Every assertion on the
      // comma-joined multi output is anchored for the same reason.
      await userEvent.click(menu.getByRole('option', { name: /Active/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('values')).toHaveTextContent(/^archived$/);
      });
    });

    await step('the listbox announces that it takes several', async () => {
      await expect(menu.getByRole('listbox', { name: /statuses/i })).toHaveAttribute(
        'aria-multiselectable',
        'true',
      );
    });

    await step('and dismissal is the explicit act', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(async () => {
        await expect(menu.queryByRole('listbox', { name: /statuses/i })).toBeNull();
      });
      // Escape dismisses the SURFACE, not the picks — they were committed as
      // they were made, so there is nothing to roll back.
      await expect(canvas.getByTestId('values')).toHaveTextContent(/^archived$/);
    });
  },
};

export const TheMultiTriggerCountsPastOne: Story = {
  render: () => <MultiHarness initial={['active']} />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('one selection shows the option label', async () => {
      await expect(canvas.getByRole('button', { name: /^Statuses: Active/ })).toBeInTheDocument();
    });

    const menu = await openMulti(canvasElement);

    await step('two shows a count with the caller noun', async () => {
      // Two labels do not fit a 240px trigger; truncating them is worse than
      // counting them.
      await userEvent.click(menu.getByRole('option', { name: /Archived/ }));
      await waitFor(async () => {
        await expect(
          canvas.getByRole('button', { name: /^Statuses: 2 statuses/ }),
        ).toBeInTheDocument();
      });
    });

    await step('and emptying it falls back to the control name', async () => {
      await userEvent.click(menu.getByRole('option', { name: /Active/ }));
      await userEvent.click(menu.getByRole('option', { name: /Archived/ }));
      await waitFor(async () => {
        await expect(canvas.getByRole('button', { name: /^Statuses: none/ })).toBeInTheDocument();
      });
    });
  },
};

/**
 * `Space` reaches the same activation as `Enter` in BOTH modes — the `case ' '`
 * falls through — so single-select gained a key it previously ignored. What is
 * asserted here is the half that differs from
 * `SpaceTogglesWhenThereIsNoSearchBox`: single-select COMMITS AND CLOSES, where
 * multi ticks and stays open. Asserting only the new value would pass in either
 * mode and prove nothing about which one ran.
 */
export const SpaceCommitsAndClosesInSingleSelect: Story = {
  args: { initial: 'active' },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: /^Status:/ });

    await step('ArrowDown opens on the current value', async () => {
      trigger.focus();
      await userEvent.keyboard('{ArrowDown}');
      await within(document.body).findByRole('listbox', { name: /status/i });
    });

    await step('ArrowDown again moves off it', async () => {
      // Space on the value already selected would commit the same value, and
      // the assertion below could not tell a commit from a no-op.
      await userEvent.keyboard('{ArrowDown}');
    });

    await step('Space commits the highlighted row AND closes', async () => {
      await userEvent.keyboard(' ');
      await waitFor(async () => {
        await expect(canvas.getByTestId('value')).toHaveTextContent('archived');
      });
      await waitFor(async () => {
        await expect(within(document.body).queryByRole('listbox', { name: /status/i })).toBeNull();
      });
    });
  },
};

export const SpaceTogglesWhenThereIsNoSearchBox: Story = {
  render: () => <MultiHarness />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: /^Statuses:/ });

    await step('ArrowDown opens on the first selectable option', async () => {
      trigger.focus();
      await userEvent.keyboard('{ArrowDown}');
      await within(document.body).findByRole('listbox', { name: /statuses/i });
    });

    await step('Space ticks it and the list stays open', async () => {
      await userEvent.keyboard(' ');
      await waitFor(async () => {
        await expect(canvas.getByTestId('values')).toHaveTextContent(/^active$/);
      });
      await expect(
        within(document.body).getByRole('listbox', { name: /statuses/i }),
      ).toBeInTheDocument();
    });

    await step('Enter ticks the next one WITHOUT closing', async () => {
      // The single-select contract is "Enter commits and closes". Multi-select
      // deliberately breaks it — closing after every tick would defeat the mode.
      await userEvent.keyboard('{ArrowDown}');
      await userEvent.keyboard('{Enter}');
      await waitFor(async () => {
        await expect(canvas.getByTestId('values')).toHaveTextContent(/^active,archived$/);
      });
      await expect(
        within(document.body).getByRole('listbox', { name: /statuses/i }),
      ).toBeInTheDocument();
    });
  },
};

export const SearchSurvivesATickSoASetCanBeBuiltFromOneQuery: Story = {
  render: () => <MultiHarness searchable />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const menu = await openMulti(canvasElement);

    // Three, not two: `memories` matches Active ("Live memories"), Archived
    // ("Archived memories") and Expiring ("Live memories expiring within 7
    // days") by hint. Only the disabled Purged row ("Not available yet") drops
    // out, which is what makes this query a real narrowing.
    await step('narrow to the three memory-shaped rows', async () => {
      await waitFor(async () => {
        await expect(document.activeElement).toBe(
          menu.getByRole('combobox', { name: /search statuses/i }),
        );
      });
      await userEvent.keyboard('memories');
      await waitFor(async () => {
        await expect(menu.getAllByRole('option')).toHaveLength(3);
      });
    });

    await step('Space types a space here rather than ticking a row', async () => {
      // The other arm of `if (searchable) break` — the half
      // `SpaceTogglesWhenThereIsNoSearchBox` cannot reach. Without the guard,
      // Space would activate the highlighted row and multi-word queries would
      // be untypeable; the highlight is on a row throughout, so a regression
      // shows up as a selection appearing out of nowhere.
      await userEvent.keyboard(' ');
      await expect(menu.getByRole('combobox', { name: /search statuses/i })).toHaveValue(
        'memories ',
      );
      await expect(canvas.getByTestId('values')).toHaveTextContent('');
    });

    await step('and backing the space out restores the three rows', async () => {
      // So the rest of the story runs against the query it documents.
      await userEvent.keyboard('{Backspace}');
      await waitFor(async () => {
        await expect(menu.getAllByRole('option')).toHaveLength(3);
      });
    });

    await step('ticking one leaves the query in place', async () => {
      // Clearing it on every tick would send the user back to the full list
      // between each pick — the exact friction the mode exists to remove.
      await userEvent.click(menu.getByRole('option', { name: /Archived/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('values')).toHaveTextContent(/^archived$/);
      });
      await expect(menu.getByRole('combobox', { name: /search statuses/i })).toHaveValue(
        'memories',
      );
      await expect(menu.getAllByRole('option')).toHaveLength(3);
    });

    await step('so the second pick is one click away', async () => {
      await userEvent.click(menu.getByRole('option', { name: /Active/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('values')).toHaveTextContent(/^archived,active$/);
      });
    });
  },
};
