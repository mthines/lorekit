import type { Meta, StoryObj } from '@storybook/react';
import { BookOpenCheck } from 'lucide-react';
import { expect, within } from 'storybook/test';

import { StatCard, TrendChip } from './StatCard';
import type { StatTrend } from '@/lib/aggregations';

/**
 * Interaction tests for the trend chip's large-delta handling.
 *
 * The arithmetic is unit-tested in `lib/format-number.spec.ts`; what only a
 * rendered DOM can prove is the part that is not arithmetic — that the exact
 * figure is still reachable when the visible one is rounded, and that a small
 * delta is rendered as ONE plain text node exactly as before (so nothing about
 * the common case changed).
 *
 * No visual baseline: the chip's appearance is already covered by the
 * `DashboardStats` and `ExplorerInsights` baselines, which render real cards.
 */
function trendWith(changePct: number): StatTrend {
  return {
    changePct,
    // Two points minimum, or `StatCard` suppresses the chip — a comparison
    // against a single bucket is a number with no meaning.
    points: [
      { label: '2026-W24', value: 3 },
      { label: '2026-W25', value: 265 },
    ],
  };
}

const meta: Meta<typeof TrendChip> = {
  title: 'Dashboard/StatCard/Tests',
  component: TrendChip,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true } },
};

export default meta;
type Story = StoryObj<typeof TrendChip>;

/**
 * The reported bug: a young scope's first busy week produced `+8834%`, which at
 * seven characters collided with the `22,425` beside it and was clipped at the
 * card's edge on a phone.
 */
export const LargeDeltaAbbreviatesButKeepsTheExactFigure: Story = {
  render: () => <TrendChip changePct={8834} title="Last 7 days vs. the preceding 7 days" />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the visible text is abbreviated', async () => {
      await expect(canvas.getByText('+8.8K%')).toBeInTheDocument();
      // The exact figure is still in the DOM — but only in the `sr-only` twin,
      // never as visible text. Asserting it is ABSENT would be wrong (and would
      // pass if the twin were dropped), so the assertion is about WHERE it is.
      const exactNode = canvas.getByText('+8834%');
      await expect(exactNode.className).toContain('sr-only');
    });

    await step('the exact figure survives for assistive tech', async () => {
      // The `AnimatedNumber` two-node pattern: the rounded half is
      // `aria-hidden`, and an `sr-only` twin carries the real number. So a
      // screen reader hears the precise value, not "8.8 K percent".
      const exact = canvasElement.querySelector('.sr-only');
      await expect(exact?.textContent).toBe('+8834%');
      const rounded = canvas.getByText('+8.8K%');
      await expect(rounded).toHaveAttribute('aria-hidden', 'true');
    });

    await step('and on hover, without a new tooltip surface', async () => {
      // Prefixed onto the title the chip already had, rather than bolted on as a
      // second hover affordance.
      const chip = canvas.getByTitle(/\+8834% — Last 7 days/);
      await expect(chip).toBeInTheDocument();
    });
  },
};

/**
 * The other half of the contract: below the threshold NOTHING changed. `+100%`
 * means "doubled" and is the one figure in that range a reader reasons about, so
 * it must not become `+0.1K%` — and it must stay a single plain text node, with no
 * `sr-only` twin and no rewritten title.
 */
export const SmallDeltaIsUntouched: Story = {
  render: () => <TrendChip changePct={100} title="Last 7 days vs. the preceding 7 days" />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('rendered verbatim', async () => {
      await expect(canvas.getByText('+100%')).toBeInTheDocument();
    });

    await step('no sr-only twin, so nothing is announced twice', async () => {
      await expect(canvasElement.querySelector('.sr-only')).toBeNull();
      await expect(canvas.getByText('+100%')).not.toHaveAttribute('aria-hidden');
    });

    await step('and the title is the comparison alone', async () => {
      await expect(
        canvas.getByTitle('Last 7 days vs. the preceding 7 days'),
      ).toBeInTheDocument();
    });
  },
};

/** A negative delta gets the same treatment, minus sign intact. */
export const NegativeLargeDeltaKeepsItsSign: Story = {
  render: () => <TrendChip changePct={-8834} title="Last 7 days vs. the preceding 7 days" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('-8.8K%')).toBeInTheDocument();
    await expect(canvasElement.querySelector('.sr-only')?.textContent).toBe('-8834%');
  },
};

/**
 * In situ: the chip must not push the headline figure around, which is the layout
 * failure that started this. Asserted from measured geometry — the two sit on one
 * row and the chip stays inside the card.
 */
export const ChipAndHeadlineShareOneRowWithoutColliding: Story = {
  render: () => (
    <div style={{ width: '18rem' }}>
      <StatCard
        icon={BookOpenCheck}
        label="Memories read"
        tag="Memory reads"
        tooltip="Memory records read in the selected range."
        value={22_425}
        description="in the last 7 days"
        trend={trendWith(8834)}
        trendTitle="Last 7 days vs. the preceding 7 days"
        rangeTitle="the last 7 days"
        unit="memories"
      />
    </div>
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const card = canvasElement.querySelector('[data-stat-card]') as HTMLElement;
    await expect(card).toBeTruthy();
    const chip = canvas.getByText('+8.8K%');

    await step('the chip stays within the card', async () => {
      const cardBox = card.getBoundingClientRect();
      const chipBox = chip.getBoundingClientRect();
      await expect(chipBox.right).toBeLessThanOrEqual(cardBox.right);
      await expect(chipBox.left).toBeGreaterThanOrEqual(cardBox.left);
    });

    await step('and the headline renders its exact, grouped value', async () => {
      // `AnimatedNumber` again: read the settled `.sr-only` half, never
      // `textContent`, which concatenates both nodes.
      const number = canvas.getByText('Memories read').parentElement?.querySelector('p');
      await expect(number?.querySelector('.sr-only')?.textContent).toBe('22,425');
    });
  },
};
