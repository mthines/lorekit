import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { StatusControl } from './StatusControl';
import {
  DEFAULT_STATUS,
  MEMORY_STATUSES,
  resolveStatus,
  statusParamValue,
  statusToQueryParams,
  type MemoryStatus,
} from '@/lib/status-filter';

/**
 * Interaction tests for the Status control.
 *
 * The control replaced an `archived` on/off button, so these cover the two
 * things that change when a boolean becomes a three-way single-select: that
 * exactly one state is ever selected (a toggle could not get this wrong; a
 * list can), and that each selection reaches the wire as the params that state
 * means.
 *
 * The control is now the shared `Combobox`, so the popup's own behaviour —
 * keyboard movement, filtering, the mobile bottom sheet — is covered by
 * `Combobox.test.stories.tsx` and `combobox.spec.ts`. What is asserted here is
 * what is specific to STATUS: the three states, their hints, and their query
 * mapping.
 *
 * The URL round-trip is asserted through the pure codec rather than a real
 * router. `useUrlState` is covered by its own tests, and what can actually
 * break here is the ENCODING — in particular the legacy-flag case, where
 * dropping the param on the default would let a stale `?archived=true` win on
 * reload and silently undo the selection.
 */
function Harness({ initial = DEFAULT_STATUS as MemoryStatus, legacyArchived = false }) {
  const [status, setStatus] = useState<MemoryStatus>(initial);
  const written = statusParamValue(status, legacyArchived);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: 420 }}>
      <StatusControl value={status} onChange={setStatus} />
      {/* The URL and the wire, rendered so an interaction can assert them. */}
      <output data-testid="param">{written === null ? '(absent)' : `status=${written}`}</output>
      <output data-testid="query">{JSON.stringify(statusToQueryParams(status))}</output>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Lore/StatusControl/Tests',
  component: Harness,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof Harness>;

/** The popup is portaled to `document.body`, so its rows resolve there. */
async function openStatus(canvasElement: HTMLElement) {
  const trigger = await within(canvasElement).findByRole('button', { name: /^Status:/ });
  await userEvent.click(trigger);
  const screen = within(document.body);
  await screen.findByRole('listbox', { name: /status/i });
  return screen;
}

export const ExactlyOneStateIsEverSelected: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the trigger names the CURRENT state without opening anything', async () => {
      // The reason this is a combobox and not three segments: the value is read
      // constantly and changed rarely, so the resting state should show the
      // answer rather than the alternatives.
      await expect(canvas.getByRole('button', { name: /^Status: Active/ })).toBeInTheDocument();
    });

    const menu = await openStatus(canvasElement);

    await step('the popup is a listbox with one option per state', async () => {
      await expect(menu.getAllByRole('option')).toHaveLength(MEMORY_STATUSES.length);
    });

    await step('Active is selected and the others are not', async () => {
      await expect(menu.getByRole('option', { name: /Active/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(menu.getByRole('option', { name: /Archived/ })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });

    await step('selecting another state deselects the previous one', async () => {
      await userEvent.click(menu.getByRole('option', { name: /Expiring/ }));
      await expect(canvas.getByRole('button', { name: /^Status: Expiring/ })).toBeInTheDocument();

      const reopened = await openStatus(canvasElement);
      // The property a boolean toggle could not get wrong and a list can: no
      // sequence of clicks may ever leave two states selected.
      const selected = reopened
        .getAllByRole('option')
        .filter((o) => o.getAttribute('aria-selected') === 'true');
      await expect(selected).toHaveLength(1);
      await userEvent.keyboard('{Escape}');
    });

    await step('the horizon is on the row, not hidden in a tooltip', async () => {
      // "Expiring" alone does not say over what period. The segmented control
      // had nowhere to put this; a list row does.
      const reopened = await openStatus(canvasElement);
      await expect(reopened.getByText(/expiring within 7 days/i)).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
    });
  },
};

export const EachStateSelectsItsQuery: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const query = () => canvas.getByTestId('query').textContent;
    const param = () => canvas.getByTestId('param').textContent;

    await step('Active is the default and writes no param', async () => {
      await expect(query()).toBe(JSON.stringify({ archived: 'false' }));
      await expect(param()).toBe('(absent)');
    });

    await step('Archived selects the archived population', async () => {
      await userEvent.click((await openStatus(canvasElement)).getByRole('option', { name: /Archived/ }));
      await expect(query()).toBe(JSON.stringify({ archived: 'true' }));
      await expect(param()).toBe('status=archived');
    });

    await step('Expiring stays a LIVE view and adds the horizon', async () => {
      // The discriminating assertion for the third state: if it sent
      // archived=true it would list the one population it is useless for.
      await userEvent.click((await openStatus(canvasElement)).getByRole('option', { name: /Expiring/ }));
      await expect(query()).toBe(
        JSON.stringify({ archived: 'false', expiring_within_days: 7 }),
      );
      await expect(param()).toBe('status=expiring');
    });
  },
};

/**
 * `?archived=true` is a documented public param that `lorekit link --archived`
 * still emits, so it is read forever. The failure this guards is subtle: with a
 * stale flag in the URL, dropping `?status=` on the default would let the flag
 * win on the next read and the user's click would appear to do nothing.
 */
export const SelectingActiveOverridesALegacyArchivedLink: Story = {
  args: { initial: 'archived', legacyArchived: true },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a legacy link opens on the archived view', async () => {
      await expect(canvas.getByRole('button', { name: /^Status: Archived/ })).toBeInTheDocument();
      await expect(resolveStatus(null, true)).toBe('archived');
    });

    await step('choosing Active writes the param EXPLICITLY rather than dropping it', async () => {
      await userEvent.click((await openStatus(canvasElement)).getByRole('option', { name: /Active/ }));
      await expect(canvas.getByTestId('param').textContent).toBe('status=active');
    });

    await step('so a reload still shows Active', async () => {
      // What the next page load would compute from the URL it just wrote.
      await expect(resolveStatus('active', true)).toBe('active');
    });
  },
};
