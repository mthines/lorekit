// Tests for `telemetry.disabled` in .lorekit.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTelemetryConfig } from '../src/telemetry.mjs';

const ENDPOINT_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ingress.example.com',
  OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok',
};

test('telemetry.disabled: true suppresses export even when endpoint is configured', () => {
  const cfg = resolveTelemetryConfig(ENDPOINT_ENV, { 'telemetry.disabled': true });
  assert.equal(cfg.enabled, false);
});

test('telemetry.disabled: false does not suppress export', () => {
  const cfg = resolveTelemetryConfig(ENDPOINT_ENV, { 'telemetry.disabled': false });
  assert.equal(cfg.enabled, true);
});

test('telemetry.disabled not set — no effect on telemetry', () => {
  const cfg = resolveTelemetryConfig(ENDPOINT_ENV, {});
  assert.equal(cfg.enabled, true);
});

test('env LOREKIT_TELEMETRY=0 still wins over telemetry.disabled: false', () => {
  const cfg = resolveTelemetryConfig(
    { ...ENDPOINT_ENV, LOREKIT_TELEMETRY: '0' },
    { 'telemetry.disabled': false },
  );
  assert.equal(cfg.enabled, false);
});
