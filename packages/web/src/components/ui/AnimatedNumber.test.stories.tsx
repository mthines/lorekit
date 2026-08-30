import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { MotionConfig } from 'motion/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { AnimatedNumber } from './AnimatedNumber';

/**
 * Interaction tests for {@link AnimatedNumber} — the one place the COUNT itself
 * is asserted, because it is the only behaviour here a screenshot cannot show.
 *
 * The property under test is not "it ends up right" (a plain `{value}` would
 * pass that) but "it passes THROUGH the values in between": the counter exists
 * to make a recomputation visible, so a version that settled instantly would be
 * a silent regression everywhere it is used. The intermediate-frame assertions
 * below are what discriminate the two.
 *
 * Sampling is done frame by frame against a tween deliberately slowed to 1s, so
 * the window a frame can land in is ~2.5× the production duration — the margin
 * that keeps this from being a stopwatch race on a loaded CI box.
 */
const SLOW = 1;
const FROM = 0;
const TO = 500;
/** A second, further target — the interruption test needs the value to CHANGE. */
const FAR = 900;

/**
 * `reducedMotion` is a prop so both branches can be driven from one harness.
 *
 * The default is `'never'`, which is an OPT-OUT of `.storybook/preview.tsx`'s
 * global `reducedMotion="always"` — the setting that keeps every OTHER story's
 * screenshot deterministic, and which would otherwise skip the very tween these
 * stories exist to assert.
 */
function Harness({
  duration = SLOW,
  reducedMotion = 'never' as 'never' | 'always',
}: {
  duration?: number;
  reducedMotion?: 'never' | 'always';
}) {
  const [value, setValue] = useState(FROM);
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <div style={{ padding: '1rem' }}>
        <button type="button" onClick={() => setValue(TO)}>
          Recount
        </button>
        <button type="button" onClick={() => setValue(FAR)}>
          Recount far
        </button>
        <p>
          <AnimatedNumber value={value} duration={duration} className="tabular-nums" />
        </p>
      </div>
    </MotionConfig>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'UI/AnimatedNumber/Tests',
  component: Harness,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof Harness>;

/** The visible (tween-owned) half — mid-count for the length of the animation. */
const digits = (canvasElement: HTMLElement) =>
  canvasElement.querySelector('p span [aria-hidden="true"]');

/** The screen-reader half — the settled value, correct on every frame. */
const announced = (canvasElement: HTMLElement) =>
  canvasElement.querySelector('p span .sr-only');

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

export const CountsThroughTheInterveningValues: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('it renders its initial value exactly, with no mount animation', async () => {
      await expect(digits(canvasElement)?.textContent).toBe(String(FROM));
    });

    const samples: string[] = [];
    await step('a new value is counted to, not swapped in', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Recount' }));
      // Sample every frame for well under the tween's length, so the samples are
      // taken while it is genuinely in flight.
      for (let i = 0; i < 20; i++) {
        samples.push(digits(canvasElement)?.textContent ?? '');
        await nextFrame();
      }
      const intermediate = samples.filter((s) => s !== String(FROM) && s !== String(TO));
      // The discriminating assertion: an instant swap produces only the two
      // endpoints, so a non-empty middle is proof the tween ran.
      await expect(intermediate.length).toBeGreaterThan(0);
    });

    await step('and it counts UP — the samples never go backwards', async () => {
      const numbers = samples.map(Number);
      for (let i = 1; i < numbers.length; i++) {
        await expect(numbers[i]!).toBeGreaterThanOrEqual(numbers[i - 1]!);
      }
    });

    await step('it settles on the exact target, not on a rounded frame', async () => {
      await waitFor(async () => {
        await expect(digits(canvasElement)?.textContent).toBe(String(TO));
      });
    });
  },
};

/**
 * The accessibility contract that justifies the two-node structure: a screen
 * reader must never be handed whatever number the tween happened to be on. The
 * announced value is committed by React on the same tick as the state change,
 * so it is already exact while the visible digits are still climbing.
 */
export const AnnouncedValueIsExactDuringTheCount: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the counting digits are hidden from assistive tech', async () => {
      await expect(digits(canvasElement)).toHaveAttribute('aria-hidden', 'true');
    });

    await step('the announced value jumps straight to the target', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Recount' }));
      // No `waitFor`: the point is that this is true IMMEDIATELY, while the
      // visible half is still mid-count. Waiting would let the tween finish and
      // the assertion would pass for the wrong reason.
      await expect(announced(canvasElement)?.textContent).toBe(String(TO));
      await expect(digits(canvasElement)?.textContent).not.toBe(String(TO));
    });
  },
};

/**
 * An interrupted count continues from what is ON SCREEN.
 *
 * Clicking through selections faster than 400ms is normal use, and resuming
 * from the last committed PROP instead would visibly snap the number back to
 * the previous answer before counting again.
 */
export const InterruptedCountResumesFromTheVisibleValue: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a second change mid-count does not snap backwards', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Recount' }));
      for (let i = 0; i < 6; i++) await nextFrame();

      const mid = Number(digits(canvasElement)?.textContent);
      await expect(mid).toBeGreaterThan(FROM);
      await expect(mid).toBeLessThan(TO);

      // A NEW target mid-flight: the effect re-runs and must pick up from
      // `mid`, not from the previous committed prop (0), which is what a
      // `previous`-prop implementation would do.
      await userEvent.click(canvas.getByRole('button', { name: 'Recount far' }));
      for (let i = 0; i < 3; i++) await nextFrame();
      await expect(Number(digits(canvasElement)?.textContent)).toBeGreaterThanOrEqual(mid);

      await waitFor(async () => {
        await expect(digits(canvasElement)?.textContent).toBe(String(FAR));
      });
    });
  },
};

/**
 * Reduce, do not remove: with reduced motion the reader still gets the answer,
 * just not the journey. The counter must land on the new value on the SAME
 * frame rather than skipping the animation and leaving the old number up.
 *
 * This is also the branch every visual baseline in the repo renders under —
 * `.storybook/preview.tsx` sets `reducedMotion="always"` — so it is what makes
 * a screenshot of a stat card reproducible.
 */
export const ReducedMotionJumpsStraightToTheValue: Story = {
  args: { reducedMotion: 'always' },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('the new value is on screen immediately, with no count', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Recount' }));
      // No `waitFor` and no frame yielding: an implementation that merely
      // shortened the tween would still be mid-count here.
      await expect(digits(canvasElement)?.textContent).toBe(String(TO));
    });

    await step('and it stays there', async () => {
      for (let i = 0; i < 5; i++) await nextFrame();
      await expect(digits(canvasElement)?.textContent).toBe(String(TO));
    });
  },
};
