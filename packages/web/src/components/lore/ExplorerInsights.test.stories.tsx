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
import { PREFERENCE_KEYS } from '@/lib/persisted-preference';
import type { TimeRange } from '@/lib/time-range';

/**
 * Interaction tests for the Explorer's Activity panel.
 *
 * These cover what a screenshot cannot: that the cards actually re-fetch and
 * re-render against a NEW selection (AC-1), that the Read card is driven by the
 * scope-filtered read series rather than the account-wide one (AC-2), and that
 * the Archived tile shows the usage ledger's archived figure (AC-3) — plus the
 * view toggle, the persisted disclosure, and the portaled bucket readout.
 *
 * The panel is ONE persistent grid of cards at two densities: compact keeps every
 * number, label and caption and folds only the evidence (trend chip, sparkbar)
 * away; expanding on the `charts` view unfolds it. So the cards — and `headline`
 * below — read the same in both states, which is the property the disclosure
 * tests pin.
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
  // Remounting the panel is how a "fresh page load" is expressed in a story: the
  // persisted preferences are read on mount, so this is the only way to prove a
  // stored choice is actually restored rather than merely held in state.
  const [instance, setInstance] = useState(0);

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
        <button type="button" onClick={() => setInstance((n) => n + 1)}>
          Remount panel
        </button>
      </div>
      <ExplorerInsights
        key={instance}
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
  // The panel's disclosure and view are now PERSISTED, and the browser suite runs
  // every story against one origin — so a story that collapses the panel would
  // otherwise decide what the next story opens on. Clearing both keys is what
  // keeps each story a statement about the DEFAULT rather than about run order.
  beforeEach: () => {
    for (const key of Object.values(PREFERENCE_KEYS)) window.localStorage.removeItem(key);
  },
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

/**
 * The first sparkbar on the panel.
 *
 * Throws rather than asserting non-null so an absent chart fails with a sentence
 * about the CHARTS VIEW being closed, which is the only way it can happen —
 * `getAllByRole` already throws when nothing matches, so the guard is about the
 * indexing, not the query.
 */
function firstChart(canvas: ReturnType<typeof within>): HTMLElement {
  const chart = canvas.getAllByRole('img')[0];
  if (!chart) throw new Error('No sparkbar rendered — is the charts view open?');
  return chart;
}

/** `getBoundingClientRect` for each element, and the first one, without a `!`. */
function boxesOf(elements: readonly Element[]): { boxes: DOMRect[]; first: DOMRect } {
  const boxes = elements.map((el) => el.getBoundingClientRect());
  const first = boxes[0];
  if (!first) throw new Error('boxesOf called with no elements');
  return { boxes, first };
}

export const CardsReflectTheActiveSelection: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    // The captions this test checks are evidence, which only the `charts` view
    // unfolds — and that is the default, so nothing has to be opened first.
    await canvas.findByRole('button', { name: /hide activity detail/i });

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
      // The caption is folded evidence, unfolded by the default `charts` view.
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
 * the EVIDENCE (sparkbars, the heatmap) folds.
 *
 * It now opens EXPANDED — showing one body at a time roughly halved the expanded
 * panel, which is what made the evidence affordable by default — so the direction
 * of travel here is expanded → collapsed → expanded.
 */
export const CollapsedStillShowsTheNumbers: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    let expandedWritten = 0;
    await step('it opens EXPANDED on the charts view, evidence showing', async () => {
      await expect(
        canvas.getByRole('button', { name: /hide activity detail/i }),
      ).toBeInTheDocument();
      await waitFor(async () => {
        // Sparkbars are on the cards that carry a series.
        await expect(canvas.getAllByRole('img').length).toBeGreaterThan(0);
        expandedWritten = await headline(canvas, 'Memories written');
        await expect(expandedWritten).toBeGreaterThan(0);
      });
      // ...and the heatmap is NOT also stacked below it — that is the whole
      // point of the view toggle. Its caption is matched by SHAPE because the
      // span is breakpoint-dependent (see HEATMAP_WEEKS); pinning the number
      // would make this a viewport test.
      await expect(canvas.queryByText(/last \d+ weeks/i)).toBeNull();
    });

    await step('collapsing folds the evidence away', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /hide activity detail/i }));
      await waitFor(async () => {
        // Collapsed is just the numbers + labels: no captions, no sparkbars, no
        // heatmap. That is what keeps the summary a thin strip of cards rather
        // than a wall of them.
        await expect(canvas.queryAllByRole('img')).toHaveLength(0);
        await expect(canvas.queryByText(/last \d+ weeks/i)).toBeNull();
        await expect(canvas.queryByText(/in the last/i)).toBeNull();
      });
    });

    await step('but the four cards keep their numbers and labels', async () => {
      for (const label of [
        'Memories written',
        'Memories read',
        'Scopes active',
        'Memories archived',
      ]) {
        await expect(canvas.getByText(label)).toBeInTheDocument();
      }
      // The card is one element folding, not a strip swapped for a different
      // card, so the figure the reader was looking at is the same one still.
      await expect(await headline(canvas, 'Memories written')).toBe(expandedWritten);
    });

    await step('re-expanding brings the evidence back', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /show activity detail/i }));
      await waitFor(async () => {
        await expect(canvas.getAllByRole('img').length).toBeGreaterThan(0);
        await expect(canvas.getByText('Memories written')).toBeInTheDocument();
      });
    });
  },
};

/**
 * The collapsed panel is a SUMMARY LINE on a phone, not a screen of tiles.
 *
 * Folding used to leave four full-scale cards stacked ONE-up below ~384px, running
 * to roughly half a phone's viewport before the first memory — so collapsing bought
 * far less room than it appeared to. Two-up at the compact density (`StatCard`'s
 * `compact`) is what fixed it, and this is the bound that keeps it fixed.
 *
 * The budget is stated in CSS pixels rather than as a fraction of the viewport,
 * because the browser runner's iframe is not a phone: 260px sits comfortably under
 * 30% of the ~915px viewport this was measured against, while staying loose enough
 * to survive a font-metric difference. It is a REGRESSION bound — the failure it
 * exists to catch is a return to the ~450px one-up stack, not a 10px drift.
 */
export const CollapsedPanelFitsAPhone: Story = {
  // A phone's content column. The harness's own `maxWidth` cannot exceed its
  // parent, so the panel lays out at phone width inside the desktop-sized runner.
  render: (args) => (
    <div style={{ width: '23rem' }}>
      <Harness {...args} />
    </div>
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByLabelText(/activity for the current selection/i);

    await step('collapse it the way a reader does', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /hide activity detail/i }));
      await waitFor(async () => {
        await expect(canvas.queryAllByRole('img')).toHaveLength(0);
      });
    });

    await step('the whole panel fits the phone budget', async () => {
      // Settle the fold FIRST. A rect read mid-transition is SHORTER than the
      // resting panel, so measuring during the animation can only manufacture a
      // false pass — the same trap the heatmap width assertion hit before.
      await waitFor(async () => {
        const before = panel.getBoundingClientRect().height;
        await new Promise((resolve) => setTimeout(resolve, 60));
        await expect(panel.getBoundingClientRect().height).toBe(before);
      });
      await expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(260);
    });

    await step('and it still carries all four numbers', async () => {
      for (const label of [
        'Memories written',
        'Memories read',
        'Scopes active',
        'Memories archived',
      ]) {
        await expect(canvas.getByText(label)).toBeInTheDocument();
      }
    });
  },
};

/**
 * The view toggle: the panel's two bodies, one at a time.
 *
 * The regression it guards is the layout this change exists to remove — four stat
 * cards with sparkbars AND a 52-week heatmap stacked in one card. So each half of
 * the assertion is a NEGATIVE about the other view, not just a positive about the
 * selected one; asserting only "the heatmap is there" would pass for the stacked
 * layout too.
 */
export const ViewToggleSwapsChartsAndHeatmap: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const toggle = within(await canvas.findByRole('radiogroup', { name: /activity view/i }));

    await step('it offers exactly two views, and opens on the charts one', async () => {
      const segments = toggle.getAllByRole('radio');
      await expect(segments).toHaveLength(2);
      await expect(toggle.getByRole('radio', { name: /stat charts/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(toggle.getByRole('radio', { name: /heatmap/i })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });

    await step('the toggle replaced the old "Activity · <scope>" label', async () => {
      // The panel keeps its accessible name on the <section>, and every card
      // caption still names the scope, so the label was redundant twice over.
      await expect(canvas.queryByText(/^Activity · /)).toBeNull();
      await expect(canvas.getByLabelText(/activity for the current selection/i)).toBeInTheDocument();
    });

    await step('charts view: sparkbars, and NO heatmap', async () => {
      await waitFor(async () => {
        await expect(canvas.getAllByRole('img').length).toBeGreaterThan(0);
      });
      await expect(canvas.queryByText(/last \d+ weeks/i)).toBeNull();
      await expect(canvas.queryByLabelText(/contribution heatmap/i)).toBeNull();
    });

    await step('heatmap view: ONLY the calendar — no cards, no sparkbars', async () => {
      await userEvent.click(toggle.getByRole('radio', { name: /heatmap/i }));
      await waitFor(async () => {
        await expect(canvas.getByText(/last \d+ weeks/i)).toBeInTheDocument();
        await expect(canvas.getByLabelText(/contribution heatmap/i)).toBeInTheDocument();
      });
      // Picking Heatmap shows the calendar and nothing else. Leaving the four
      // cards stacked above it rebuilt the very layout this panel exists to
      // remove, so their absence is the assertion — not merely that their
      // evidence folded. Under `waitFor` because they leave through an
      // AnimatePresence exit and are still mounted for a frame after the click.
      await waitFor(async () => {
        await expect(canvasElement.querySelectorAll('[data-stat-card]')).toHaveLength(0);
        await expect(canvas.queryAllByRole('img')).toHaveLength(0);
      });
    });

    await step('the four numbers are one chevron away, never lost', async () => {
      // Folding must not cost the answer on ANY view: collapsing out of the
      // heatmap brings the summary line back rather than emptying the panel.
      await userEvent.click(canvas.getByRole('button', { name: /hide activity detail/i }));
      await waitFor(async () => {
        await expect(canvas.queryByLabelText(/contribution heatmap/i)).toBeNull();
      });
      for (const label of [
        'Memories written',
        'Memories read',
        'Scopes active',
        'Memories archived',
      ]) {
        await expect(canvas.getByText(label)).toBeInTheDocument();
      }
      // Under `waitFor`: the grid is absent on the expanded heatmap view, so
      // collapsing REMOUNTS it and each figure counts up from 0 (AnimatedNumber).
      // Reading the headline on the first frame after a mount is a race that only
      // ever resolves to 0 — the same reason the expanded step above waits.
      await waitFor(async () => {
        await expect(await headline(canvas, 'Memories written')).toBeGreaterThan(0);
      });
    });

    await step('switching back restores the charts and drops the calendar', async () => {
      await userEvent.click(toggle.getByRole('radio', { name: /stat charts/i }));
      await waitFor(async () => {
        await expect(canvas.getAllByRole('img').length).toBeGreaterThan(0);
        await expect(canvas.queryByLabelText(/contribution heatmap/i)).toBeNull();
      });
    });
  },
};

/**
 * Picking a view while the panel is folded EXPANDS it.
 *
 * Without this, clicking "Heatmap" on a collapsed panel lights the segment up and
 * changes nothing visible — a dead control. "Show me the heatmap" is a request to
 * SEE it, not to select it for later.
 */
export const PickingAViewWhileCollapsedExpands: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const toggle = within(await canvas.findByRole('radiogroup', { name: /activity view/i }));

    await step('collapse it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /hide activity detail/i }));
      await waitFor(async () => {
        await expect(
          canvas.getByRole('button', { name: /show activity detail/i }),
        ).toBeInTheDocument();
      });
    });

    await step('clicking Heatmap opens the panel onto it', async () => {
      await userEvent.click(toggle.getByRole('radio', { name: /heatmap/i }));
      await waitFor(async () => {
        await expect(
          canvas.getByRole('button', { name: /hide activity detail/i }),
        ).toBeInTheDocument();
        await expect(canvas.getByLabelText(/contribution heatmap/i)).toBeInTheDocument();
      });
    });
  },
};

/**
 * The persistence, which is the ask: "if you prefer them collapsed, they stay
 * like that".
 *
 * Remounting the panel is how a fresh page load is expressed here — the
 * preference is read on mount, so a test that only toggled state would pass
 * without any storage at all. Both halves matter: the key is written, AND a new
 * mount honours it.
 */
export const CollapsePersistsAcrossRemount: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a fresh browser opens expanded — nothing is stored yet', async () => {
      await expect(window.localStorage.getItem(PREFERENCE_KEYS.explorerInsightsOpen)).toBeNull();
      await expect(
        canvas.getByRole('button', { name: /hide activity detail/i }),
      ).toBeInTheDocument();
    });

    await step('collapsing writes the choice', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /hide activity detail/i }));
      await waitFor(async () => {
        await expect(window.localStorage.getItem(PREFERENCE_KEYS.explorerInsightsOpen)).toBe('0');
      });
    });

    await step('a fresh mount comes back collapsed', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Remount panel' }));
      await waitFor(async () => {
        await expect(
          canvas.getByRole('button', { name: /show activity detail/i }),
        ).toBeInTheDocument();
      });
      // …and it is genuinely collapsed, not merely labelled that way.
      await expect(canvas.queryAllByRole('img')).toHaveLength(0);
    });

    await step('re-expanding writes the opposite choice, so it is not one-way', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /show activity detail/i }));
      await waitFor(async () => {
        await expect(window.localStorage.getItem(PREFERENCE_KEYS.explorerInsightsOpen)).toBe('1');
      });
      await userEvent.click(canvas.getByRole('button', { name: 'Remount panel' }));
      await waitFor(async () => {
        await expect(
          canvas.getByRole('button', { name: /hide activity detail/i }),
        ).toBeInTheDocument();
      });
    });
  },
};

/** The view choice is the same kind of per-viewer preference, so it persists too. */
export const ViewChoicePersistsAcrossRemount: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const toggle = within(await canvas.findByRole('radiogroup', { name: /activity view/i }));

    await step('pick the heatmap', async () => {
      await userEvent.click(toggle.getByRole('radio', { name: /heatmap/i }));
      await waitFor(async () => {
        await expect(window.localStorage.getItem(PREFERENCE_KEYS.explorerInsightsView)).toBe(
          'heatmap',
        );
      });
    });

    await step('a fresh mount opens on it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Remount panel' }));
      await waitFor(async () => {
        const restored = within(canvas.getByRole('radiogroup', { name: /activity view/i }));
        await expect(restored.getByRole('radio', { name: /heatmap/i })).toHaveAttribute(
          'aria-checked',
          'true',
        );
        await expect(canvas.getByLabelText(/contribution heatmap/i)).toBeInTheDocument();
      });
    });
  },
};

/**
 * A stored value the app no longer understands must degrade to the default rather
 * than rendering a view that does not exist. This is the version-skew case: a
 * preference written by a build that offered a third body.
 */
export const AnUnknownStoredViewFallsBackToTheDefault: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    window.localStorage.setItem(PREFERENCE_KEYS.explorerInsightsView, 'sparklines');
    window.localStorage.setItem(PREFERENCE_KEYS.explorerInsightsOpen, 'perhaps');
    await userEvent.click(await canvas.findByRole('button', { name: 'Remount panel' }));

    await waitFor(async () => {
      const toggle = within(canvas.getByRole('radiogroup', { name: /activity view/i }));
      await expect(toggle.getByRole('radio', { name: /stat charts/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      // An unparseable disclosure value falls back to the default too, which is
      // expanded — not to `false`, which would collapse a panel nobody folded.
      await expect(
        canvas.getByRole('button', { name: /hide activity detail/i }),
      ).toBeInTheDocument();
    });
  },
};

/**
 * The cropped tooltip, which is the third ask.
 *
 * The readout used to be an `absolute` panel inside the sparkbar, and the
 * sparkbar lives in a reveal region that is `overflow: hidden` so the card can
 * animate its height — so it was clipped at the card's edge. The discriminating
 * assertion is therefore NOT "a tooltip appeared" (it appeared before too) but
 * "the tooltip is not inside a stat card": a portaled panel is a child of
 * `<body>`, outside the story canvas entirely.
 */
export const BucketTooltipEscapesTheClippingCard: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    await waitFor(async () => {
      await expect(canvas.getAllByRole('img').length).toBeGreaterThan(0);
    });

    await step('nothing is shown until a bucket is active', async () => {
      await expect(body.queryByRole('tooltip')).toBeNull();
    });

    await step('hovering a sparkbar bucket shows the readout', async () => {
      const column = firstChart(canvas).firstElementChild as HTMLElement;
      await userEvent.hover(column);
      await waitFor(async () => {
        await expect(body.getByRole('tooltip')).toBeInTheDocument();
      });
    });

    await step('and it is PORTALED — not a descendant of the clipping card', async () => {
      const tooltip = body.getByRole('tooltip');
      // The two facts that together mean "cannot be cropped": it is a direct
      // child of <body>, and it has no stat-card ancestor to be clipped by.
      await expect(tooltip.parentElement).toBe(document.body);
      await expect(tooltip.closest('[data-stat-card]')).toBeNull();
      await expect(canvasElement.contains(tooltip)).toBe(false);
      // `fixed`, so it is positioned in viewport coordinates rather than inside
      // the card's coordinate space.
      await expect(getComputedStyle(tooltip).position).toBe('fixed');
    });

    await step('keyboard focus opens it too, and Escape closes it', async () => {
      await userEvent.keyboard('{Escape}');
      const chart = firstChart(canvas);
      chart.focus();
      await expect(chart).toHaveFocus();
      await userEvent.keyboard('{ArrowLeft}');
      await waitFor(async () => {
        await expect(body.getByRole('tooltip')).toBeInTheDocument();
      });
      await userEvent.keyboard('{Escape}');
      await waitFor(async () => {
        await expect(body.queryByRole('tooltip')).toBeNull();
      });
    });

    await step('the heatmap day readout is portaled the same way', async () => {
      const toggle = within(canvas.getByRole('radiogroup', { name: /activity view/i }));
      await userEvent.click(toggle.getByRole('radio', { name: /heatmap/i }));
      const grid = await canvas.findByLabelText(/contribution heatmap/i);
      const cell = grid.querySelectorAll('button')[0] as HTMLElement;
      await userEvent.hover(cell);
      await waitFor(async () => {
        const tooltip = body.getByRole('tooltip');
        await expect(tooltip.parentElement).toBe(document.body);
        await expect(canvasElement.contains(tooltip)).toBe(false);
      });
    });
  },
};

/**
 * The header at phone width, which is where three controls in one row goes wrong.
 *
 * Asserted from measured geometry rather than class names — a `hidden @md:inline`
 * that something else overrode would still read as the right class. The container
 * is narrowed rather than the viewport, because the toggle's label collapse keys
 * off the PANEL's container width, which is the point.
 */
export const HeaderFitsOnOneRowAtPhoneWidth: Story = {
  render: () => (
    <div style={{ maxWidth: '23rem', padding: '0.75rem' }}>
      <ExplorerInsights
        scope={null}
        scopeLabel="All scopes"
        range={{ preset: '30d' }}
        onRangeChange={() => undefined}
        filters={[]}
        heatmapData={HEATMAP}
        highlightRange={null}
        onSelectDate={() => undefined}
        nowIso={FROZEN_NOW}
      />
    </div>
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByLabelText(/activity for the current selection/i);
    const toggle = await canvas.findByRole('radiogroup', { name: /activity view/i });
    const picker = canvas.getByRole('radiogroup', { name: /time range/i });
    const chevron = canvas.getByRole('button', { name: /activity detail/i });

    await step('all three controls sit on ONE row', async () => {
      const { boxes, first } = boxesOf([toggle, picker, chevron]);
      for (const box of boxes) {
        await expect(Math.abs(box.top - first.top)).toBeLessThan(box.height);
      }
    });

    await step('and none of them overflows the panel', async () => {
      const panelBox = panel.getBoundingClientRect();
      for (const el of [toggle, picker, chevron]) {
        const box = el.getBoundingClientRect();
        await expect(box.left).toBeGreaterThanOrEqual(panelBox.left - 1);
        await expect(box.right).toBeLessThanOrEqual(panelBox.right + 1);
      }
    });

    await step('the toggle gives up its LABELS rather than the row', async () => {
      // Icon-only at this width — but still named, so a screen reader is
      // unaffected by the visual collapse. Read the label's COMPUTED display,
      // not `textContent`: a `display:none` node still reports its text, so a
      // textContent assertion would pass whether or not the label was hidden.
      const segments = within(toggle).getAllByRole('radio');
      await expect(segments).toHaveLength(2);
      for (const segment of segments) {
        const label = segment.querySelector('span');
        if (!label) throw new Error('A segment rendered no label span at all');
        await expect(getComputedStyle(label).display).toBe('none');
        await expect(segment.getAttribute('aria-label')).toBeTruthy();
        // The icon is what is left, so the segment is not simply empty.
        await expect(segment.querySelector('svg')).toBeTruthy();
      }
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
