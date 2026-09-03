import { describe, it, expect } from 'vitest';
import { formatTokenVolume, formatShare, readDeliveryCost, CHARS_PER_TOKEN_ESTIMATE } from './lore-cost';
import type { UtilityCost } from '@lorekit/schemas/memory';

const cost = (over: Partial<UtilityCost> = {}): UtilityCost => ({
  delivered_reads: 0,
  chosen_reads: 0,
  delivered_tokens: 0,
  chosen_tokens: 0,
  ...over,
});

describe('formatTokenVolume', () => {
  it('leaves a number under a thousand alone, suffix and all', () => {
    // `0.8K` is harder to read than `840`, and this is a headline.
    expect(formatTokenVolume(840)).toBe('840');
    expect(formatTokenVolume(999)).toBe('999');
  });

  it('drops the decimal once a unit is in double digits', () => {
    // The second digit of a 602-million-token ESTIMATE is noise the estimate
    // cannot support, so it is not printed.
    expect(formatTokenVolume(602_000_000)).toBe('602M');
    expect(formatTokenVolume(84_000)).toBe('84K');
  });

  it('keeps one decimal below ten of a unit, where it carries information', () => {
    expect(formatTokenVolume(1_200_000)).toBe('1.2M');
    expect(formatTokenVolume(1_500)).toBe('1.5K');
    expect(formatTokenVolume(2_400_000_000)).toBe('2.4B');
  });

  it('reports zero as zero, not as an empty string or a suffix', () => {
    expect(formatTokenVolume(0)).toBe('0');
  });

  it('floors a negative at zero rather than printing one', () => {
    // Nothing should produce a negative token count; if something does, a
    // headline reading `-4M tokens delivered` is worse than a wrong zero.
    expect(formatTokenVolume(-4)).toBe('0');
  });
});

describe('formatShare', () => {
  it('keeps two significant figures below one percent', () => {
    // The measured store-wide baseline is 0.20%. At one decimal, 0.15% and
    // 0.24% would both print as 0.2% — collapsing exactly the range this
    // number exists to distinguish.
    expect(formatShare(0.0019)).toBe('0.19%');
    expect(formatShare(0.0002)).toBe('0.020%');
  });

  it('uses one decimal above one percent, and none when it is whole', () => {
    expect(formatShare(0.124)).toBe('12.4%');
    expect(formatShare(0.25)).toBe('25%');
  });

  it('is zero, not a rounding of zero', () => {
    expect(formatShare(0)).toBe('0%');
  });

  it('returns null for an absent rate rather than inventing 0%', () => {
    // No denominator is not the same claim as "nothing was chosen", and the
    // caller phrases the difference in words.
    expect(formatShare(null)).toBeNull();
  });
});

describe('readDeliveryCost', () => {
  it('takes the share over TOKENS, matching the headline it sits beside', () => {
    // Reads and tokens disagree here on purpose: 2 of 10 reads but 1M of 10M
    // tokens. A percentage printed next to a token headline must be the token
    // share, or a reader compounds two different denominators.
    const reading = readDeliveryCost(
      cost({ delivered_reads: 10, chosen_reads: 2, delivered_tokens: 10_000_000, chosen_tokens: 1_000_000 }),
    );
    expect(reading.chosenShare).toBeCloseTo(0.1);
    expect(reading.chosenShareLabel).toBe('10%');
    expect(reading.deliveredTokens).toBe('10M');
    expect(reading.chosenTokens).toBe('1.0M');
  });

  it('carries both read counts, because one delivery is not one cost', () => {
    const reading = readDeliveryCost(cost({ delivered_reads: 12_345, chosen_reads: 67 }));
    expect(reading.deliveredReads).toBe('12,345');
    expect(reading.chosenReads).toBe('67');
  });

  it('answers for an empty account without dividing by zero', () => {
    const reading = readDeliveryCost(cost());
    expect(reading.chosenShare).toBeNull();
    expect(reading.chosenShareLabel).toBeNull();
    expect(reading.isEmpty).toBe(true);
  });

  it('distinguishes "delivered but never chosen" from "nothing delivered"', () => {
    // Both render 0%-ish, and they are different facts: the first is the
    // noise-tax case the page exists to surface, the second is a quiet window.
    const neverChosen = readDeliveryCost(cost({ delivered_reads: 400, delivered_tokens: 900_000 }));
    expect(neverChosen.isEmpty).toBe(false);
    expect(neverChosen.chosenShareLabel).toBe('0%');
  });
});

describe('CHARS_PER_TOKEN_ESTIMATE', () => {
  it('is the same constant the SQL sum divides by', () => {
    // `lorekit_memory_delivery_cost` computes `ceil(length(value) / 4.0)`. The
    // number is re-exported here so a surface rendering the estimate can name
    // the assumption, and so changing it is one edit in @lorekit/schemas
    // rather than a silent disagreement between the label and the figure.
    expect(CHARS_PER_TOKEN_ESTIMATE).toBe(4);
  });
});
