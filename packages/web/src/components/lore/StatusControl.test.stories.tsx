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
 * exactly one state is ever active (a toggle could not get this wrong; a
 * radiogroup can), and that each selection reaches the wire as the params that
 * state means.
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

export const ExactlyOneStateIsEverSelected: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('it is a radiogroup with one option per state', async () => {
      const group = canvas.getByRole('radiogroup', { name: /status/i });
      await expect(within(group).getAllByRole('radio')).toHaveLength(MEMORY_STATUSES.length);
    });

    await step('Active is checked by default and the others are not', async () => {
      await expect(canvas.getByRole('radio', { name: /^Active/ })).toBeChecked();
      await expect(canvas.getByRole('radio', { name: /^Archived/ })).not.toBeChecked();
      await expect(canvas.getByRole('radio', { name: /^Expiring/ })).not.toBeChecked();
    });

    await step('selecting another state deselects the previous one', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /^Expiring/ }));
      await expect(canvas.getByRole('radio', { name: /^Expiring/ })).toBeChecked();
      // The property a boolean toggle could not get wrong and a radiogroup can:
      // no combination of clicks may ever leave two states active.
      const checked = canvas
        .getAllByRole('radio')
        .filter((r) => r.getAttribute('aria-checked') === 'true');
      await expect(checked).toHaveLength(1);
    });

    await step('the horizon is in the accessible name, not just the tooltip', async () => {
      // "Expiring" alone does not say over what period, and the control is too
      // small to spell it out visually.
      await expect(canvas.getByRole('radio', { name: /Expiring.*7 days/i })).toBeInTheDocument();
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
      await userEvent.click(canvas.getByRole('radio', { name: /^Archived/ }));
      await expect(query()).toBe(JSON.stringify({ archived: 'true' }));
      await expect(param()).toBe('status=archived');
    });

    await step('Expiring stays a LIVE view and adds the horizon', async () => {
      // The discriminating assertion for the third state: if it sent
      // archived=true it would list the one population it is useless for.
      await userEvent.click(canvas.getByRole('radio', { name: /^Expiring/ }));
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
      await expect(canvas.getByRole('radio', { name: /^Archived/ })).toBeChecked();
      await expect(resolveStatus(null, true)).toBe('archived');
    });

    await step('choosing Active writes the param EXPLICITLY rather than dropping it', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /^Active/ }));
      await expect(canvas.getByTestId('param').textContent).toBe('status=active');
    });

    await step('so a reload still shows Active', async () => {
      // What the next page load would compute from the URL it just wrote.
      await expect(resolveStatus('active', true)).toBe('active');
    });
  },
};
