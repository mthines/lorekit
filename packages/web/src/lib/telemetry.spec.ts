import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushLogs, logger, withSpan } from './telemetry';

// Silence the stdout/stderr copy: NX reads a test run's output for failure
// signals, and an ERROR line on stderr must not look like one.
function captureStdio() {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { stdout, stderr };
}

describe('logger with an SDK registered', () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider();
  // A delay no test waits out: a record only reaches the exporter when
  // flushLogs() flushes the batch, which is the path production depends on.
  provider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 60_000 }));

  beforeAll(() => {
    logs.setGlobalLoggerProvider(provider);
  });

  afterAll(async () => {
    logs.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
    vi.restoreAllMocks();
  });

  it('emits each level as an OTLP log record with the matching severity', async () => {
    captureStdio();

    logger.info('lorekit.test.info', { 'lorekit.org.role': 'owner' });
    logger.warn('lorekit.test.warn');
    logger.error('lorekit.test.error', { 'exception.type': 'TypeError' });

    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    await flushLogs();

    const records = exporter.getFinishedLogRecords();
    expect(records.map((r) => [r.body, r.severityText, r.severityNumber])).toEqual([
      ['lorekit.test.info', 'INFO', SeverityNumber.INFO],
      ['lorekit.test.warn', 'WARN', SeverityNumber.WARN],
      ['lorekit.test.error', 'ERROR', SeverityNumber.ERROR],
    ]);
    expect(records[0]?.attributes).toEqual({ 'lorekit.org.role': 'owner' });
    expect(records[2]?.attributes).toEqual({ 'exception.type': 'TypeError' });
    expect(records[0]?.instrumentationScope.name).toBe('lorekit.web');
  });

  it('keeps the single-line JSON copy: INFO on stdout, WARN and ERROR on stderr', () => {
    const { stdout, stderr } = captureStdio();

    logger.info('lorekit.test.info', { 'lorekit.org.role': 'owner' });
    logger.error('lorekit.test.error');

    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({ level: 'INFO', msg: 'lorekit.test.info', 'lorekit.org.role': 'owner' }) + '\n',
    );
    expect(stderr).toHaveBeenCalledWith(JSON.stringify({ level: 'ERROR', msg: 'lorekit.test.error' }) + '\n');
  });

  it('records a failed withSpan as an ERROR log record carrying the exception', async () => {
    captureStdio();

    await expect(
      withSpan('lorekit.test.op', {}, async () => {
        throw new TypeError('boom');
      }),
    ).rejects.toThrow('boom');
    await flushLogs();

    const [record] = exporter.getFinishedLogRecords();
    expect(record?.body).toBe('lorekit.test.op.failed');
    expect(record?.severityText).toBe('ERROR');
    expect(record?.attributes).toMatchObject({
      'exception.type': 'TypeError',
      'exception.message': 'boom',
    });
  });
});

describe('logger without an SDK registered', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('flushLogs resolves, and logging still writes the stdout copy', async () => {
    const { stdout } = captureStdio();

    logger.info('lorekit.test.no-sdk');

    await expect(flushLogs()).resolves.toBeUndefined();
    expect(stdout).toHaveBeenCalledOnce();
  });
});
