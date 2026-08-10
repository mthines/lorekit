import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { Archive, BookOpen, Clock } from 'lucide-react';

import { Combobox, type ComboboxItem } from './Combobox';

/**
 * Interaction tests for the shared single-select popup list.
 *
 * These cover the parts a screenshot cannot: the keyboard model, the fact that
 * the list opens ON the current value, filtering, and the two dismissal paths.
 * The arithmetic behind all of it (wrapping, skipping disabled options,
 * re-homing a highlight after a filter) is unit-tested in `combobox.spec.ts`;
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
