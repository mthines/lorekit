import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ExplorerInsights } from './ExplorerInsights';
import { memoryHandlers, FROZEN_NOW, ARCHIVED_RECORDS, MEMORY_ROWS } from '@/mocks/memories';

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
 * the Archived tile shows the usage ledger's archived figure (AC-3).
 *
 * The panel is ONE persistent grid of cards at two densities: collapsed keeps
 * every number, label and caption and folds only the evidence (trend chip,
 * sparkbar, heatmap) away; expanding unfolds it. So the cards — and `headline`
 * below — read the same in both states, which is the property the disclosure
 * test pins.
 *
 * The header is propless-by-selection in production — `LoreExplorer` owns the
 * scope and range — so the harness below owns them instead and exposes controls
 * to change them, which is exactly the interaction under test.
 */
function Harness({
  initialScope = null as string | null,
  initialRange = { preset: '30d' } as TimeRange,
  onRangeChange,
}: {
  initialScope?: string | null;
  /** `null` is the "reader has not chosen" state the 24h display default covers. */
  initialRange?: TimeRange;
  /** Spied in the default-range story to prove the panel never WRITES its default. */
  onRangeChange?: (range: TimeRange) => void;
}) {
  const [scope, setScope] = useState<string | null>(initialScope);
  const [range, setRange] = useState<TimeRange>(initialRange);

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
        onRangeChange={(next) => {
          setRange(next);
          onRangeChange?.(next);
        }}
        filters={[]}
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

/**
 * The exact value an `AnimatedNumber` currently stands for.
 *
 * NOT the element's `textContent`: the counter renders two nodes — the visible
 * digits, which a tween owns and which are mid-count for ~400ms after any
 * change, and a screen-reader-only sibling carrying the settled value. Reading
 * the whole element concatenates both ("1212"), so every assertion here goes
 * through the exact half. Tests that care about the TWEEN read the visible half
 * instead — see `AnimatedNumber.test.stories.tsx`.
 */
function exactValue(el: Element | null | undefined): number {
  return Number(el?.querySelector('.sr-only')?.textContent?.trim());
}

/** The headline number rendered on a card, by the card's label. */
async function headline(canvas: ReturnType<typeof within>, label: string): Promise<number> {
  const labelEl = await canvas.findByText(label);
  // The number is the first paragraph inside the same number block as the label.
  return exactValue(labelEl.parentElement?.querySelector('p'));
}

/**
 * The stat card that owns a given label.
 *
 * Anchored on `data-stat-card`, the hook `StatCard` exists to expose — NOT on
 * `.rounded-xl`, which the insights panel `<section>` also carries: with that
 * selector, restyling the card's radius silently resolves all four lookups to
 * the one panel, and every geometry assertion below would then be comparing a
 * box against itself. Throws rather than returning null so a renamed hook fails
 * loudly instead of degrading into a vacuous pass.
 */
function cardOf(canvas: ReturnType<typeof within>, label: string): HTMLElement {
  const card = canvas.getByText(label).closest('[data-stat-card]');
  if (!card) throw new Error(`No [data-stat-card] ancestor for the "${label}" card`);
  return card as HTMLElement;
}

export const CardsReflectTheActiveSelection: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    // Numbers read in either density, but the captions this test checks are
    // evidence — folded away when collapsed — so open the panel first.
    await userEvent.click(await canvas.findByRole('button', { name: /show activity detail/i }));

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

export const ArchivedTileShowsTheUsageLedger: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the headline is archived, from GET /memories/usage', async () => {
      // Expiry is intentionally NOT a figure here: the product expires on read,
      // so there is no expiry event to count. Archived is the one countable
      // lifecycle metric.
      await waitFor(async () => {
        await expect(await headline(canvas, 'Memories archived')).toBe(ARCHIVED_RECORDS);
      });
    });

    await step('it is ACCOUNT-wide — selecting a scope does not change it', async () => {
      // Archiving is recorded per user, so the event carries no scope to narrow
      // by. A header that pretended otherwise would invent a number the API
      // cannot produce.
      await userEvent.click(canvas.getByRole('button', { name: 'Select repo' }));
      await waitFor(async () => {
        await expect(await headline(canvas, 'Memories archived')).toBe(ARCHIVED_RECORDS);
      });
    });

    await step('and its caption says so instead of naming the scope', async () => {
      // The caption is folded evidence — open the panel to read it.
      await userEvent.click(await canvas.findByRole('button', { name: /show activity detail/i }));
      await waitFor(async () => {
        await expect(canvas.getByText(/across your account/)).toBeInTheDocument();
      });
    });

    await step('it draws no sparkbar — archived has no per-bucket series yet', async () => {
      // The OTHER cards reveal sparkbars once expanded; the Archived card has none.
      await waitFor(async () => {
        await expect(canvas.getAllByRole('img').length).toBeGreaterThan(0);
      });
      const card = cardOf(canvas, 'Memories archived');
      await expect(card.querySelector('[role="img"]')).toBeNull();
    });
  },
};

/**
 * The disclosure, which is the point of the redesign.
 *
 * A collapsed panel that showed nothing would be hiding, not disclosing — and
 * that is what the earliest version did: it folded all four figures away and
 * left a header reading "Activity". The property under test is that the ANSWER
 * (the four cards' numbers, labels and captions) survives the collapse and only
 * the EVIDENCE (sparkbars + heatmap) folds.
 */
export const CollapsedStillShowsTheNumbers: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('it opens COLLAPSED — the evidence is folded away', async () => {
      await expect(
        canvas.getByRole('button', { name: /show activity detail/i }),
      ).toBeInTheDocument();
      // Collapsed is just the numbers + labels: no icons/tags, no captions, no
      // sparkbars, no heatmap. That is what keeps the summary a thin strip of
      // cards rather than a wall of them.
      await expect(canvas.queryAllByRole('img')).toHaveLength(0);
      await expect(canvas.queryByText(/last \d+ weeks/i)).toBeNull();
      await expect(canvas.queryByText(/in the last/i)).toBeNull();
    });

    let collapsedWritten = 0;
    await step('but the four cards keep their numbers and labels', async () => {
      await waitFor(async () => {
        for (const label of [
          'Memories written',
          'Memories read',
          'Scopes active',
          'Memories archived',
        ]) {
          await expect(canvas.getByText(label)).toBeInTheDocument();
        }
        collapsedWritten = await headline(canvas, 'Memories written');
        await expect(collapsedWritten).toBeGreaterThan(0);
      });
    });

    await step('expanding reveals the evidence behind them', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /show activity detail/i }));
      await waitFor(async () => {
        // Sparkbars appear on the cards that carry a series...
        await expect(canvas.getAllByRole('img').length).toBeGreaterThan(0);
        // ...and the heatmap unfolds below. Its span is breakpoint-dependent (a
        // quarter on a phone, a year on a desktop — see HEATMAP_WEEKS), so the
        // caption is matched by SHAPE; pinning the number would make this a
        // viewport test.
        await expect(canvas.getByText(/last \d+ weeks/i)).toBeInTheDocument();
      });
    });

    await step('and the number is unchanged by the expand — it never moved', async () => {
      // The card is one element growing, not a strip swapped for a different
      // card, so the figure the reader was looking at is the same one now.
      await expect(await headline(canvas, 'Memories written')).toBe(collapsedWritten);
    });

    await step('collapsing folds the evidence back, keeping the numbers', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /hide activity detail/i }));
      await waitFor(async () => {
        await expect(canvas.queryAllByRole('img')).toHaveLength(0);
        await expect(canvas.getByText('Memories written')).toBeInTheDocument();
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
      const before = await headline(canvas, 'Memories written');
      await userEvent.click(group.getByRole('radio', { name: /All/i }));
      await waitFor(async () => {
        await expect(group.getByRole('radio', { name: /All/i })).toHaveAttribute(
          'aria-checked',
          'true',
        );
      });
      // All time is a superset of the seeded window, so the figure cannot fall.
      // `headline` reads the settled (screen-reader) half of the counter, so
      // this does not race the count-up animation the change kicks off.
      await waitFor(async () => {
        await expect(await headline(canvas, 'Memories written')).toBeGreaterThanOrEqual(before);
      });
    });
  },
};

/**
 * The panel's own opening question.
 *
 * An absent `?range=` means the reader has not chosen a window. The LIST reads
 * that as all time (a list's job is to show everything, and every existing
 * `/lore` deep link means that by an absent param), but an Activity panel
 * showing a lifetime total has nothing to compare and nothing that moves — so
 * the panel substitutes the last 24 hours for DISPLAY only.
 *
 * The load-bearing half of this test is the last step: the default must never
 * be written back, or it would stop being a display default and start
 * re-scoping every shared link that omits the param.
 */
export const UntouchedRangeShowsTheLast24Hours: Story = {
  args: { initialRange: null, onRangeChange: fn() },
  play: async ({ canvasElement, args, step }) => {
    const canvas = within(canvasElement);
    const group = within(await canvas.findByRole('radiogroup', { name: /time range/i }));

    await step('the picker opens on 24h, not on All', async () => {
      await expect(group.getByRole('radio', { name: /last 24h/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(group.getByRole('radio', { name: /all time/i })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });

    await step('and the cards describe that window', async () => {
      // The caption is folded evidence now, so open the panel to read it.
      await userEvent.click(canvas.getByRole('button', { name: /show activity detail/i }));
      await waitFor(async () => {
        await expect(canvas.getAllByText(/in the last 24 hours/i).length).toBeGreaterThan(0);
      });
    });

    await step('but the panel never WRITES the default back to the caller', async () => {
      // The whole point of the substitution: the list below is untouched until
      // the reader actually picks something. A panel that emitted its own
      // default on mount would silently narrow every `?range=`-less link.
      await expect(args.onRangeChange).not.toHaveBeenCalled();
    });

    await step('choosing All is a real choice, distinct from the default', async () => {
      await userEvent.click(group.getByRole('radio', { name: /all time/i }));
      // `{preset:'all'}`, not `null` — that is what keeps "chose All" and
      // "has not chosen" two different states. See RangePicker.
      await expect(args.onRangeChange).toHaveBeenLastCalledWith({ preset: 'all' });
      await waitFor(async () => {
        // The cards then chart 90 days, and SAY 90 days — an unbounded window
        // has no grid to bucket and no preceding period to compare, so
        // `effectiveStatsRange` substitutes one and the caption names what was
        // actually drawn. The point of this assertion is that the panel moved
        // OFF the 24h default, which is what proves the default was a display
        // substitution and not a hard-coded window.
        await expect(canvas.getAllByText(/in the last 90 days/i).length).toBeGreaterThan(0);
        await expect(canvas.queryByText(/in the last 24 hours/i)).toBeNull();
      });
    });
  },
};

/**
 * The stat grid's layout, which is a real behaviour and not a style: at a wide
 * panel the four cards sit in ONE row of four equal columns. The columns key off
 * the PANEL's width (`@container` + `@3xl`), not the viewport, so a narrow embed
 * drops to two-up instead of cramming four cards into a ~370px column. This
 * story's harness is a wide 72rem panel, so four-up is the expected layout.
 *
 * Asserted from measured geometry rather than class names — a `grid-cols-4` that
 * something else overrode would still read as the right class.
 */
export const CardsAreOneRowOfFourEqualColumnsWhenWide: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await waitFor(async () => {
      await expect(await headline(canvas, 'Memories written')).toBeGreaterThan(0);
    });

    const labels = ['Memories written', 'Memories read', 'Scopes active', 'Memories archived'];
    const cards = labels.map((label) => cardOf(canvas, label));
    // Anti-vacuity: four labels must resolve to four DISTINCT cards. If they
    // ever collapsed onto one shared ancestor, the geometry steps below would be
    // comparing a box with itself.
    await expect(new Set(cards).size).toBe(labels.length);
    const items = cards.map((card) => card.getBoundingClientRect());

    await step('all four sit on a single row', async () => {
      for (const box of items) {
        await expect(Math.abs(box.top - items[0]!.top)).toBeLessThan(1);
      }
    });

    await step('they are laid out left to right, in reading order', async () => {
      for (let i = 1; i < items.length; i++) {
        await expect(items[i]!.left).toBeGreaterThan(items[i - 1]!.left);
      }
    });

    await step('the columns are equal, so the row is a grid and not a packed line', async () => {
      for (const box of items) {
        await expect(Math.abs(box.width - items[0]!.width)).toBeLessThan(1);
      }
    });

    await step('and the row spans the panel rather than clustering on the left', async () => {
      const panel = canvas.getByLabelText(/activity for the current selection/i);
      const last = items[items.length - 1]!;
      const panelBox = panel.getBoundingClientRect();
      await expect(panelBox.right - last.right).toBeLessThan(panelBox.width / 4);
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
