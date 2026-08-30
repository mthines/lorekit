/**
 * Deterministic, stateless variant assignment for A/B(/n) experiments.
 *
 * The same `(flagKey, targetingKey)` pair must always land in the same
 * bucket — for the lifetime of the experiment, across every process, with no
 * shared storage — or the same user flips between "control" and "treatment"
 * on every request and the conversion comparison the flag exists to produce
 * is meaningless. Hashing `${flagKey}:${targetingKey}` (FNV-1a, 32-bit) into
 * `[0, 100)` and walking the variants' cumulative weight gives exactly that:
 * pure, no RNG, no cache, reproducible in a test.
 */
import type { Experiment } from './schema.ts';

/** FNV-1a, 32-bit. Not cryptographic — fast, well-distributed, good enough for bucketing. */
export function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Maps a hash into `[0, 100)`, the same domain as `ExperimentVariant.weight`. */
export function bucketOf(flagKey: string, targetingKey: string): number {
  return fnv1aHash(`${flagKey}:${targetingKey}`) % 100;
}

/**
 * Walks `experiment.variants` in declared order, accumulating weight, and
 * returns the first variant whose cumulative range contains the bucket.
 * `FlagRegistrySchema` already guarantees the weights sum to 100, so this
 * always resolves — the fallback return only satisfies the type checker.
 */
export function assignExperimentVariant(
  flagKey: string,
  experiment: Experiment,
  targetingKey: string,
): string {
  const bucket = bucketOf(flagKey, targetingKey);
  let cumulative = 0;
  for (const variant of experiment.variants) {
    cumulative += variant.weight;
    if (bucket < cumulative) return variant.key;
  }
  return experiment.variants[experiment.variants.length - 1].key;
}
