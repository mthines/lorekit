import { describe, expect, it } from 'vitest';
import { assignExperimentVariant, bucketOf, fnv1aHash } from './bucketing.ts';
import type { Experiment } from './schema.ts';

const experiment: Experiment = {
  enabled: true,
  variants: [
    { key: 'control', weight: 50 },
    { key: 'treatment', weight: 50 },
  ],
};

describe('fnv1aHash / bucketOf', () => {
  it('is deterministic for the same input', () => {
    expect(fnv1aHash('a')).toBe(fnv1aHash('a'));
    expect(bucketOf('flag', 'user-1')).toBe(bucketOf('flag', 'user-1'));
  });

  it('produces different buckets for different targeting keys (usually)', () => {
    const buckets = new Set(Array.from({ length: 20 }, (_, i) => bucketOf('flag', `user-${i}`)));
    // Not a strict uniformity test — just guards against a degenerate constant hash.
    expect(buckets.size).toBeGreaterThan(1);
  });

  it('stays within [0, 100)', () => {
    for (let i = 0; i < 200; i++) {
      const bucket = bucketOf('flag', `user-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });
});

describe('assignExperimentVariant', () => {
  it('is stable for the same (flagKey, targetingKey) pair', () => {
    const a = assignExperimentVariant('new-onboarding-flow', experiment, 'user-42');
    const b = assignExperimentVariant('new-onboarding-flow', experiment, 'user-42');
    expect(a).toBe(b);
  });

  it('assigns every user to a declared variant', () => {
    for (let i = 0; i < 500; i++) {
      const variant = assignExperimentVariant('flag', experiment, `user-${i}`);
      expect(['control', 'treatment']).toContain(variant);
    }
  });

  it('respects a 0/100 split — everyone lands on the 100% arm', () => {
    const allControl: Experiment = {
      enabled: true,
      variants: [
        { key: 'control', weight: 100 },
        { key: 'treatment', weight: 0 },
      ],
    };
    for (let i = 0; i < 100; i++) {
      expect(assignExperimentVariant('flag', allControl, `user-${i}`)).toBe('control');
    }
  });

  it('produces a roughly even split for a 50/50 experiment over a large sample', () => {
    let treatmentCount = 0;
    const sampleSize = 2000;
    for (let i = 0; i < sampleSize; i++) {
      if (assignExperimentVariant('flag', experiment, `user-${i}`) === 'treatment')
        treatmentCount++;
    }
    const ratio = treatmentCount / sampleSize;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });

  it('a different flag key produces an independent assignment for the same targeting key', () => {
    // Not guaranteed for every user, but the population should differ overall,
    // which we check by ensuring at least one of a sample of users flips.
    let sawDifference = false;
    for (let i = 0; i < 50; i++) {
      const key = `user-${i}`;
      const a = assignExperimentVariant('flag-a', experiment, key);
      const b = assignExperimentVariant('flag-b', experiment, key);
      if (a !== b) sawDifference = true;
    }
    expect(sawDifference).toBe(true);
  });
});
