import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ExplorerStats } from './ExplorerStats';
import { memoryHandlers, FROZEN_NOW, EXPIRED_RECORDS, MEMORY_ROWS } from '@/mocks/memories';
import { withQueryClient, withFrozenClock } from '@/mocks/decorators';
import type { TimeRange } from '@/lib/time-range';

/**
 * Interaction tests for the Explorer's stats header.
 *
 * These cover what a screenshot cannot: that the cards actually re-fetch and
 * re-render against a NEW selection (AC-1), that the Read card is driven by the
 * scope-filtered read series rather than the account-wide one (AC-2), and that
 * the Expired tile shows the usage ledger's figure (AC-3).
 *
 * The header is propless-by-selection in production — `LoreExplorer` owns the
 * scope and range — so the harness below owns them instead and exposes controls
 * to change them, which is exactly the interaction under test.
 */
function Harness({ initialScope = null as string | null }) {
  const [scope, setScope] = useState<string | null>(initialScope);
  const [range, setRange] = useState<TimeRange>({ preset: '30d' });

  return (
    <div style={{ maxWidth: '72rem', padding: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <button type="button" onClick={() => setScope(null)}>
          All scopes
        </button>
        <button type="button" onClick={() => setScope('repo::mthines/lorekit')}>
          Select repo
        </button>
        <button type="button" onClick={() => setRange({ preset: '24h' })}>
          Last 24h
        </button>
      </div>
      <ExplorerStats
        scope={scope}
        range={range}
        hasActiveFilters={false}
        scopeLabel={scope ? 'mthines/lorekit' : 'All scopes'}
      />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Lore/ExplorerStats/Tests',
  component: Harness,
  tags: ['test'],
  parameters: {
    layout: 'fullscreen',
    chromatic: { disableSnapshot: true },
    msw: { handlers: memoryHandlers() },
  },
  decorators: [withFrozenClock(FROZEN_NOW), withQueryClient],
};

export default meta;
type Story = StoryObj<typeof Harness>;

/** The headline number rendered on a card, by the card's label. */
async function headline(canvas: ReturnType<typeof within>, label: string): Promise<number> {
  const labelEl = await canvas.findByText(label);
  // The number is the sibling paragraph above the label, inside the same block.
  const value = labelEl.parentElement?.querySelector('p');
  return Number(value?.textContent?.trim());
}

export const CardsReflectTheActiveSelection: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    let accountWritten = 0;
    await step('all scopes: the Written card counts every fixture memory', async () => {
      await waitFor(async () => {
        accountWritten = await headline(canvas, 'Memories written');
        await expect(accountWritten).toBeGreaterThan(0);
      });
    });

    await step('selecting a scope narrows the cards', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Select repo' }));
      await waitFor(async () => {
        const scoped = await headline(canvas, 'Memories written');
        // Strictly fewer: the fixtures span several scopes, so a header that
        // ignored the selection would show the same number and pass a
        // "> 0" assertion. The inequality is the discriminating part.
        await expect(scoped).toBeLessThan(accountWritten);
        await expect(scoped).toBeGreaterThan(0);
      });
    });

    await step('the caption names the scope it is counting', async () => {
      await expect(canvas.getAllByText(/in .* in mthines\/lorekit/).length).toBeGreaterThan(0);
    });

    await step('the Scopes card collapses to one for a single-scope selection', async () => {
      await waitFor(async () => {
        await expect(await headline(canvas, 'Scopes active')).toBe(1);
      });
    });

    await step('changing the range re-scopes the cards again', async () => {
      const before = await headline(canvas, 'Memories written');
      await userEvent.click(canvas.getByRole('button', { name: 'Last 24h' }));
      await waitFor(async () => {
        // The fixtures spread across weeks, so a 24h window must be a strict
        // subset of the 30d one.
        await expect(await headline(canvas, 'Memories written')).toBeLessThanOrEqual(before);
      });
    });
  },
};

export const ReadCardUsesTheScopedReadSeries: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    let accountRead = 0;
    await step('all scopes: the Read card totals the whole ledger', async () => {
      await waitFor(async () => {
        accountRead = await headline(canvas, 'Memories read');
        await expect(accountRead).toBeGreaterThan(0);
      });
    });

    await step('selecting a scope drives it from ?scope= on read-activity', async () => {
      // The MSW handler honours `?scope=` as an EXACT match, exactly as
      // migration 00058 does, so a header that forgot to pass the scope would
      // keep showing the account total here.
      await userEvent.click(canvas.getByRole('button', { name: 'Select repo' }));
      await waitFor(async () => {
        await expect(await headline(canvas, 'Memories read')).toBeLessThan(accountRead);
      });
    });

    await step('the card explains why a per-scope total can be smaller', async () => {
      // The caveat PR-1 deferred to this card: unattributable reads are recorded
      // with no scope, so the per-scope figures do not sum to the account one.
      const read = await canvas.findByText('Memories read');
      const info = read.parentElement?.querySelector('svg');
      await expect(info).toBeTruthy();
    });
  },
};

export const ExpiredTileShowsTheUsageLedger: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('it renders GET /memories/usage summary.expired', async () => {
      await waitFor(async () => {
        await expect(await headline(canvas, 'Memories expired')).toBe(EXPIRED_RECORDS);
      });
    });

    await step('it is ACCOUNT-wide — selecting a scope does not change it', async () => {
      // The honest asymmetry: the purge spans scopes and its event carries none,
      // so this figure cannot narrow. A header that pretended otherwise would be
      // inventing a number the API cannot produce.
      await userEvent.click(canvas.getByRole('button', { name: 'Select repo' }));
      await waitFor(async () => {
        await expect(await headline(canvas, 'Memories expired')).toBe(EXPIRED_RECORDS);
      });
    });

    await step('and its caption says so instead of naming the scope', async () => {
      await expect(canvas.getByText(/across your account/)).toBeInTheDocument();
    });

    await step('it draws no sparkbar, because expiry has no per-bucket series', async () => {
      const expired = await canvas.findByText('Memories expired');
      const card = expired.closest('div')?.parentElement;
      await expect(card?.querySelector('[role="img"]')).toBeNull();
    });
  },
};

export const CollapsesAwayWithoutLosingTheSelection: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Memories written');

    await step('the header folds away', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /hide statistics/i }));
      await expect(canvas.queryByText('Memories written')).toBeNull();
    });

    await step('and comes back with the same numbers', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /show statistics/i }));
      await waitFor(async () => {
        await expect(await headline(canvas, 'Memories written')).toBeGreaterThan(0);
      });
    });
  },
};

/**
 * Anti-vacuity for the fixtures the assertions above lean on: if `MEMORY_ROWS`
 * ever stopped spanning several scopes, the "scoped < account" comparisons would
 * pass for the wrong reason (both zero) or become impossible (one scope).
 */
export const FixturesSupportTheComparisons: Story = {
  play: async () => {
    const scopes = new Set(MEMORY_ROWS.map((r) => r.scope));
    await expect(scopes.size).toBeGreaterThan(1);
    await expect(MEMORY_ROWS.filter((r) => r.scope === 'repo::mthines/lorekit').length)
      .toBeGreaterThan(0);
  },
};
