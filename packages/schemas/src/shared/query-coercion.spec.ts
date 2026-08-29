/**
 * One invariant over EVERY `*QuerySchema` in this package: a numeric or
 * boolean field must be declared with `z.coerce`, never bare.
 *
 * Query schemas are fed `Object.fromEntries(url.searchParams.entries())` by
 * `_shared/api/validate.ts`'s `validateQuery`, so every value they ever see is
 * a **string**. A bare `z.number()` therefore does not merely lose a default —
 * it 400s (`Expected number, received string`) on every caller that sends the
 * param at all, and only on those callers, so the route looks healthy from any
 * probe that omits it.
 *
 * That is exactly how `GET /memories/read-ranking?limit=20` and
 * `GET /memories/usage/runs?limit=20` shipped broken: both dashboard panels
 * (Insights → Hot & cold lore, Insights → Runs) pass `limit`, both got a 400,
 * and both render a React Query error as their "no data yet" empty state — so
 * a live, fully-populated backend read as an empty account.
 *
 * A per-schema test would not have caught it (neither schema had one). This
 * asserts the property instead of the instances, so a NEW query schema with a
 * bare `z.number()` fails here on the day it is written.
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import * as common from './common.ts';
import * as relevant from './relevant.ts';
import * as memory from '../domain/memory.ts';
import * as usage from '../domain/usage.ts';
import * as blog from '../domain/blog.ts';

const MODULES: Record<string, Record<string, unknown>> = {
  'shared/common.ts': common,
  'shared/relevant.ts': relevant,
  'domain/memory.ts': memory,
  'domain/usage.ts': usage,
  'domain/blog.ts': blog,
};

/**
 * Strip the wrappers a query field is normally declared with
 * (`.optional()`, `.default()`, `.nullable()`, `.transform()`) down to the
 * type that actually parses the incoming string.
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  // Bounded: the wrapper chains in this package are 2-3 deep, never cyclic.
  for (let i = 0; i < 10; i++) {
    const def = current._def as { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    const inner = def.innerType ?? def.schema;
    if (!inner) return current;
    current = inner;
  }
  return current;
}

interface QueryField {
  schemaName: string;
  moduleName: string;
  fieldName: string;
  field: z.ZodTypeAny;
}

function queryFields(): QueryField[] {
  const out: QueryField[] = [];
  for (const [moduleName, mod] of Object.entries(MODULES)) {
    for (const [schemaName, value] of Object.entries(mod)) {
      if (!schemaName.endsWith('QuerySchema')) continue;
      if (!(value instanceof z.ZodObject)) continue;
      for (const [fieldName, field] of Object.entries(value.shape)) {
        out.push({ schemaName, moduleName, fieldName, field: field as z.ZodTypeAny });
      }
    }
  }
  return out;
}

const FIELDS = queryFields();

describe('query schemas are string-tolerant', () => {
  it('finds the query schemas at all (guards against a silently empty sweep)', () => {
    const names = new Set(FIELDS.map((f) => f.schemaName));
    expect(names.size).toBeGreaterThanOrEqual(10);
    // The two that shipped broken — if either is ever renamed away, this test
    // should be updated deliberately, not quietly stop covering them.
    expect(names).toContain('ReadRankingQuerySchema');
    expect(names).toContain('UsageRunsQuerySchema');
  });

  const numeric = FIELDS.filter(({ field }) => unwrap(field) instanceof z.ZodNumber);

  it('has numeric query fields to check', () => {
    expect(numeric.length).toBeGreaterThan(0);
  });

  it.each(numeric)(
    '$moduleName → $schemaName → $fieldName is declared with z.coerce',
    ({ field }) => {
      const inner = unwrap(field) as z.ZodNumber;
      expect((inner._def as { coerce?: boolean }).coerce).toBe(true);
    },
  );

  const boolean = FIELDS.filter(({ field }) => unwrap(field) instanceof z.ZodBoolean);

  it.each(boolean)(
    '$moduleName → $schemaName → $fieldName is declared with z.coerce',
    ({ field }) => {
      const inner = unwrap(field) as z.ZodBoolean;
      expect((inner._def as { coerce?: boolean }).coerce).toBe(true);
    },
  );
});

describe('the two schemas the Insights page depends on', () => {
  it('ReadRankingQuerySchema accepts the string limit a query string carries', () => {
    const parsed = memory.ReadRankingQuerySchema.parse({ direction: 'cold', limit: '20' });
    expect(parsed).toEqual({ direction: 'cold', limit: 20 });
  });

  it('UsageRunsQuerySchema accepts the string limit a query string carries', () => {
    expect(usage.UsageRunsQuerySchema.parse({ limit: '20' }).limit).toBe(20);
  });

  it.each(['0', '101', 'abc', '1.5'])(
    'still rejects an out-of-range/non-numeric limit: %s',
    (limit) => {
      expect(memory.ReadRankingQuerySchema.safeParse({ limit }).success).toBe(false);
      expect(usage.UsageRunsQuerySchema.safeParse({ limit }).success).toBe(false);
    },
  );
});
