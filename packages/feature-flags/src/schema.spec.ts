import { describe, expect, it } from 'vitest';
import { FlagDefinitionSchema, FlagRegistrySchema } from './schema.ts';

function baseFlag(overrides: Record<string, unknown> = {}) {
  return {
    key: 'my-flag',
    description: 'A test flag.',
    type: 'boolean',
    variants: { off: false, on: true },
    defaultVariant: 'off',
    owner: '@lorekit/web',
    tags: [],
    ...overrides,
  };
}

describe('FlagDefinitionSchema', () => {
  it('accepts a well-formed static flag', () => {
    expect(FlagDefinitionSchema.safeParse(baseFlag()).success).toBe(true);
  });

  it('rejects a non-kebab-case key', () => {
    const result = FlagDefinitionSchema.safeParse(baseFlag({ key: 'MyFlag' }));
    expect(result.success).toBe(false);
  });

  it('rejects a defaultVariant not present in variants', () => {
    const result = FlagDefinitionSchema.safeParse(baseFlag({ defaultVariant: 'missing' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'defaultVariant')).toBe(true);
    }
  });

  it('rejects a variant value whose type does not match the declared type', () => {
    const result = FlagDefinitionSchema.safeParse(
      baseFlag({ variants: { off: false, on: 'yes' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an experiment whose variant weights do not sum to 100', () => {
    const result = FlagDefinitionSchema.safeParse(
      baseFlag({
        experiment: {
          enabled: true,
          variants: [
            { key: 'off', weight: 40 },
            { key: 'on', weight: 40 },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an experiment variant key not present in variants', () => {
    const result = FlagDefinitionSchema.safeParse(
      baseFlag({
        experiment: {
          enabled: true,
          variants: [
            { key: 'off', weight: 50 },
            { key: 'nonexistent', weight: 50 },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed experiment whose weights sum to 100', () => {
    const result = FlagDefinitionSchema.safeParse(
      baseFlag({
        experiment: {
          enabled: true,
          variants: [
            { key: 'off', weight: 30 },
            { key: 'on', weight: 70 },
          ],
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a string-typed flag', () => {
    const result = FlagDefinitionSchema.safeParse(
      baseFlag({
        type: 'string',
        variants: { beta: 'Beta', earlyAccess: 'Early Access' },
        defaultVariant: 'beta',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts an object-typed flag with a nested variant value', () => {
    const result = FlagDefinitionSchema.safeParse(
      baseFlag({
        type: 'object',
        variants: {
          default: { title: 'Hello', links: ['/a', '/b'] },
          playful: { title: 'Hey!', links: [] },
        },
        defaultVariant: 'default',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an object-typed flag whose variant value is a primitive', () => {
    const result = FlagDefinitionSchema.safeParse(
      baseFlag({
        type: 'object',
        variants: { default: 'not-an-object' },
        defaultVariant: 'default',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a boolean-typed flag whose variant value is an object', () => {
    const result = FlagDefinitionSchema.safeParse(
      baseFlag({ variants: { off: false, on: { nope: true } } }),
    );
    expect(result.success).toBe(false);
  });
});

describe('FlagRegistrySchema', () => {
  it('rejects duplicate flag keys', () => {
    const result = FlagRegistrySchema.safeParse([baseFlag(), baseFlag()]);
    expect(result.success).toBe(false);
  });

  it('accepts a list of unique, valid flags', () => {
    const result = FlagRegistrySchema.safeParse([baseFlag(), baseFlag({ key: 'other-flag' })]);
    expect(result.success).toBe(true);
  });
});
