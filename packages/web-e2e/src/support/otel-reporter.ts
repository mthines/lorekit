import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { BASE_URL, TARGET } from './env';
import { loadOtlpExport, loadTelemetryConfig } from './otel-modules';
import { buildTestSpans, type OtlpEncoder, type OtlpSpan, type PathRedactions } from './otel-spans';

/**
 * Ships every test attempt to Dash0 as a trace (`service.name=e2e`), so a red —
 * or slowly greying — deploy gate is diagnosable from telemetry, and flakes and
 * durations can be charted across runs. Span shape: `otel-spans.ts`.
 *
 * Export is the repo's existing one: the CLI's `resolveTelemetryConfig` decides
 * endpoint, credential, dataset and opt-outs (`LOREKIT_TELEMETRY_TOKEN` in CI;
 * `LOREKIT_TELEMETRY=off` / `DO_NOT_TRACK=1` opt out), and `otlp-export.mjs`
 * encodes and POSTs. With no credential nothing is sent.
 *
 * Results are collected during the run and sent ONCE, from `onEnd`. A failed
 * export prints a line and never fails a run: the tests are the gate, their
 * telemetry is not.
 *
 * E2E_OTEL_OUT=<file> also writes the payload there, sent or not — the way to
 * see exactly what would leave the machine.
 */

export default class OtelReporter implements Reporter {
  private readonly finished: [TestCase, TestResult][] = [];
  private rootDir = process.cwd();
  /** The monorepo root — playwright.config.ts sits in packages/web-e2e/. */
  private repoRoot = process.cwd();

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir;
    if (config.configFile) this.repoRoot = resolve(dirname(config.configFile), '../..');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.finished.push([test, result]);
  }

  async onEnd(): Promise<void> {
    if (this.finished.length === 0) return;
    try {
      await this.export();
    } catch (err) {
      console.log(`otel: e2e span export skipped — ${(err as Error).message}`);
    }
  }

  private async export(): Promise<void> {
    const otlp = await loadOtlpExport();
    const spans = this.finished.flatMap(([test, result]) => this.spansFor(test, result, otlp));
    const payload = otlp.spansEnvelope('e2e', spans, runResource(process.env));

    const out = process.env['E2E_OTEL_OUT'];
    if (out) writeFileSync(out, JSON.stringify(payload, null, 2));

    const resolveTelemetryConfig = await loadTelemetryConfig();
    const cfg = resolveTelemetryConfig(process.env);
    if (!cfg.enabled) {
      if (process.env['CI']) console.log(`otel: e2e spans not exported (${cfg.reason})`);
      return;
    }
    const res = await otlp.post(`${cfg.endpoint}/v1/traces`, cfg.headers, payload);
    console.log(
      res.ok
        ? `otel: exported ${spans.length} e2e spans for ${this.finished.length} test attempts (service.name=e2e)`
        : `otel: e2e span export failed — ${res.error}`,
    );
  }

  /** Repo-relative paths in error text, and `~` for anything else under home. */
  private pathRedactions(): PathRedactions {
    return [
      [this.repoRoot + sep, ''],
      [homedir(), '~'],
    ];
  }

  private spansFor(test: TestCase, result: TestResult, encoder: OtlpEncoder): OtlpSpan[] {
    // titlePath(): ['', project, file, ...describes, title]
    const [, , , ...titlePath] = test.titlePath();
    return buildTestSpans(
      {
        titlePath,
        projectName: test.parent.project()?.name ?? '',
        file: relative(this.rootDir, test.location.file),
        line: test.location.line,
        tags: test.tags,
        expectedStatus: test.expectedStatus,
        skipReason: test.annotations.find((a) => a.type === 'skip')?.description,
      },
      result,
      (bytes) => randomBytes(bytes).toString('hex'),
      encoder,
      this.pathRedactions(),
    );
  }
}

/** Run-wide resource attributes: what was tested, and the CI run that tested it. */
export function runResource(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const github = env['GITHUB_ACTIONS'] === 'true';
  const correlation = env['LOREKIT_CORRELATION_ID']?.trim();
  return {
    'lorekit.e2e.target': TARGET,
    'lorekit.e2e.base_url': BASE_URL,
    // Same bounds as smoke-telemetry.ts's header: the one key a deploy run's
    // CLI, REST, MCP and browser smokes share.
    'lorekit.correlation_id':
      correlation && correlation.length <= 200 && /^[A-Za-z0-9_\-./:#@]+$/.test(correlation) ? correlation : undefined,
    'cicd.pipeline.name': github ? env['GITHUB_WORKFLOW'] : undefined,
    'cicd.pipeline.task.name': github ? env['GITHUB_JOB'] : undefined,
    'cicd.pipeline.run.id': github ? env['GITHUB_RUN_ID'] : undefined,
    'cicd.pipeline.run.url.full': github
      ? `${env['GITHUB_SERVER_URL']}/${env['GITHUB_REPOSITORY']}/actions/runs/${env['GITHUB_RUN_ID']}`
      : undefined,
  };
}
