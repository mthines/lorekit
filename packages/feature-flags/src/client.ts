/**
 * The public evaluation surface every LoreKit package should call through —
 * never `OpenFeature` or `LoreKitFlagProvider` directly. Centralising the
 * provider + hook registration here means every caller (web, CLI, edge
 * functions) gets the OTel instrumentation "for free" the first time it
 * calls `evaluateFlag`, with no per-call-site setup to forget.
 */
import { OpenFeature, type Client, type EvaluationContext } from '@openfeature/server-sdk';
import { featureFlagOtelHook } from './otel-hook.ts';
import { LoreKitFlagProvider } from './provider.ts';
import { getFlagDefinition } from './registry.ts';
import type { FlagKey, FlagValue } from './generated/flags.generated.ts';

const CLIENT_DOMAIN = 'lorekit-feature-flags';

let registered = false;

function ensureRegistered(): void {
  if (registered) return;
  OpenFeature.setProvider(new LoreKitFlagProvider());
  OpenFeature.addHooks(featureFlagOtelHook);
  registered = true;
}

/** The shared OpenFeature client. Provider + OTel hook are registered on first call. */
export function getFeatureFlagClient(): Client {
  ensureRegistered();
  return OpenFeature.getClient(CLIENT_DOMAIN);
}

/**
 * Evaluate a flag by its generated, typed key. The return type is inferred
 * from `flags.generated.ts` — `evaluateFlag('usage-charts-v2', ctx)` types as
 * `Promise<boolean>`, and a key not in the registry is a compile error, not a
 * runtime `FLAG_NOT_FOUND`.
 */
export async function evaluateFlag<K extends FlagKey>(
  key: K,
  context: EvaluationContext = {},
): Promise<FlagValue<K>> {
  const def = getFlagDefinition(key);
  if (!def) {
    // Unreachable when `key` is a real `FlagKey` from the generated union — this
    // only fires if the registry and the generated file have drifted (stale
    // codegen). Fail loudly rather than silently returning `undefined`.
    throw new Error(
      `@lorekit/feature-flags: unknown flag "${key}" — run \`nx run feature-flags:generate\`.`,
    );
  }
  const client = getFeatureFlagClient();
  const fallback = def.variants[def.defaultVariant];

  switch (def.type) {
    case 'boolean':
      return (await client.getBooleanValue(
        key,
        fallback as boolean,
        context,
      )) as unknown as FlagValue<K>;
    case 'string':
      return (await client.getStringValue(
        key,
        fallback as string,
        context,
      )) as unknown as FlagValue<K>;
    case 'number':
      return (await client.getNumberValue(
        key,
        fallback as number,
        context,
      )) as unknown as FlagValue<K>;
  }
}

/** Test-only escape hatch: force the OTel-instrumented registration to run again with a fresh provider. */
export function resetFeatureFlagClientForTests(): void {
  registered = false;
}
