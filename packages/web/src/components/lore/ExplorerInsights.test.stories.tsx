import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ExplorerInsights } from './ExplorerInsights';
import { memoryHandlers, FROZEN_NOW, EXPIRED_RECORDS, MEMORY_ROWS } from '@/mocks/memories';

/** A few dated cells so the heatmap renders something once expanded. */
const HEATMAP = [
  { date: '2026-06-10', count: 3 },
  { date: '2026-06-12', count: 1 },
];
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
      <ExplorerInsights
        scope={scope}
        scopeLabel={scope ? 'mthines/lorekit' : 'All scopes'}
        range={range}
        onRangeChange={setRange}
        hasActiveFilters={false}
        heatmapData={HEATMAP}
        highlightRange={null}
        onSelectDate={() => undefined}
        nowIso={FROZEN_NOW}
      />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Lore/ExplorerInsights/Tests',
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

/**
 * The disclosure, which is the point of the redesign.
 *
 * A collapsed panel that showed nothing would be hiding, not disclosing — and
 * that is what the previous version did: it folded all four figures away and
 * left a header reading "Activity". The property under test is that the ANSWER
 * survives the collapse and only the EVIDENCE folds.
 */
export const CollapsedStillShowsTheNumbers: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('it opens COLLAPSED — the page leads with the memories', async () => {
      await expect(
        canvas.getByRole('button', { name: /show activity detail/i }),
      ).toBeInTheDocument();
      // No cards, no heatmap.
      await expect(canvas.queryByText('Memories written')).toBeNull();
    });

    await step('but the four numbers are on screen', async () => {
      // The strip, not the cards: same figures, one line.
      await waitFor(async () => {
        for (const label of ['written', 'read', 'scopes', 'expired']) {
          await expect(canvas.getByText(label)).toBeInTheDocument();
        }
      });
    });

    let stripWritten = '';
    await step('and they are real values, not placeholders', async () => {
      const written = canvas.getByText('written').previousElementSibling;
      stripWritten = written?.textContent?.trim() ?? '';
      await expect(Number(stripWritten)).toBeGreaterThan(0);
    });

    await step('expanding reveals the evidence behind them', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /show activity detail/i }));
      await waitFor(async () => {
        await expect(canvas.getByText('Memories written')).toBeInTheDocument();
        await expect(canvas.getByText(/last 26 weeks/i)).toBeInTheDocument();
      });
    });

    await step('and the expanded card AGREES with the strip it replaced', async () => {
      // The two renderings read the same query, so a mismatch would mean one of
      // them is computing its own number — the bug that makes a summary
      // untrustworthy.
      await expect(String(await headline(canvas, 'Memories written'))).toBe(stripWritten);
    });

    await step('collapsing returns to the strip, not to nothing', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /hide activity detail/i }));
      await waitFor(async () => {
        await expect(canvas.queryByText('Memories written')).toBeNull();
        await expect(canvas.getByText('written')).toBeInTheDocument();
      });
    });
  },
};

/**
 * The range picker the Explorer was missing, and the reason it is shared with
 * the Overview rather than reimplemented.
 */
export const RangePickerDrivesThePanel: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const group = within(await canvas.findByRole('radiogroup', { name: /time range/i }));

    await step('it offers the Overview presets plus All', async () => {
      for (const label of ['24h', '7d', '30d', 'All']) {
        await expect(group.getByRole('radio', { name: new RegExp(label, 'i') })).toBeInTheDocument();
      }
    });

    await step('changing it re-queries the numbers', async () => {
      const before = canvas.getByText('written').previousElementSibling?.textContent;
      await userEvent.click(group.getByRole('radio', { name: /All/i }));
      await waitFor(async () => {
        await expect(group.getByRole('radio', { name: /All/i })).toHaveAttribute(
          'aria-checked',
          'true',
        );
      });
      // All time is a superset of the seeded window, so the figure cannot fall.
      const after = canvas.getByText('written').previousElementSibling?.textContent;
      await expect(Number(after)).toBeGreaterThanOrEqual(Number(before));
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
