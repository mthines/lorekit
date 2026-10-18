import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OtlpEncoder, OtlpSpan } from './otel-spans';

/**
 * The two ES modules the e2e telemetry reuses rather than copies:
 *
 *   scripts/telemetry/otlp-export.mjs    the OTLP/JSON encoder + POST shared by
 *                                        the sweep/load/eval exporters
 *   packages/cli/src/telemetry/…mjs      `resolveTelemetryConfig` — endpoint,
 *                                        credential, dataset, opt-outs
 *
 * Loaded with `import()` because Playwright compiles this package to CommonJS,
 * which cannot statically import an ES module.
 */
const REPO_ROOT = resolve(__dirname, '../../../..');
const moduleUrl = (path: string) => pathToFileURL(resolve(REPO_ROOT, path)).href;

export interface OtlpExport extends OtlpEncoder {
  spansEnvelope(serviceName: string, spans: OtlpSpan[], extraResource?: Record<string, string | undefined>): unknown;
  post(url: string, headers: Record<string, string>, payload: unknown): Promise<{ ok: boolean; error?: string }>;
}

export type TelemetryConfig =
  | { enabled: true; endpoint: string; headers: Record<string, string> }
  | { enabled: false; reason: string };

export async function loadOtlpExport(): Promise<OtlpExport> {
  return import(moduleUrl('scripts/telemetry/otlp-export.mjs'));
}

export async function loadTelemetryConfig(): Promise<(env: NodeJS.ProcessEnv) => TelemetryConfig> {
  const { resolveTelemetryConfig } = await import(moduleUrl('packages/cli/src/telemetry/telemetry.mjs'));
  return resolveTelemetryConfig;
}
