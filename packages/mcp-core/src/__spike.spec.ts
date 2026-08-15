import { describe, it, expect } from 'vitest';
import { ExportBatch, Span } from '../../../supabase/functions/_shared/otel.ts';

describe('spike', () => {
  it('imports', () => {
    const batch = new ExportBatch();
    const root = new Span('root', { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true }, batch);
    const { span, flush } = root.detachedChild('child');
    expect(typeof flush).toBe('function');
    span.end();
    expect(batch.drain()).toHaveLength(0);
  });
});
