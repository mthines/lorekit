import { describe, it, expect } from 'vitest';

import { buttonClasses, type ButtonSize, type ButtonVariant } from './button-styles';

const VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'danger',
  'danger-outline',
];
const SIZES: ButtonSize[] = ['sm', 'md', 'lg'];

describe('buttonClasses', () => {
  it('defaults to the secondary md variant', () => {
    const classes = buttonClasses();
    expect(classes).toContain('bg-[var(--color-bg-elevated)]');
    expect(classes).toContain('min-h-9');
  });

  it('uses page-background foreground for the primary CTA (not a raw hex)', () => {
    const classes = buttonClasses({ variant: 'primary' });
    expect(classes).toContain('bg-[var(--color-accent)]');
    expect(classes).toContain('text-[var(--color-bg)]');
    expect(classes).not.toContain('text-[#000]');
  });

  it('gives danger a solid destructive fill (the confirm CTA)', () => {
    const classes = buttonClasses({ variant: 'danger' });
    expect(classes).toContain('bg-[var(--color-error)]');
    expect(classes).toContain('text-[var(--color-bg)]');
  });

  it('gives danger-outline a bordered→fill treatment (inline revoke)', () => {
    const classes = buttonClasses({ variant: 'danger-outline' });
    expect(classes).toContain('border-[var(--color-error)]');
    expect(classes).toContain('hover:bg-[var(--color-error)]');
  });

  it('maps each size to its height', () => {
    expect(buttonClasses({ size: 'sm' })).toContain('min-h-8');
    expect(buttonClasses({ size: 'md' })).toContain('min-h-9');
    // lg (40px) is the full-width / hero CTA size, not an inline footer.
    expect(buttonClasses({ size: 'lg' })).toContain('min-h-10');
  });

  it('swaps horizontal padding for square sizing in icon-only mode', () => {
    const icon = buttonClasses({ size: 'md', iconOnly: true });
    expect(icon).toContain('size-9');
    expect(icon).toContain('shrink-0');
    expect(icon).not.toContain('px-3.5');
  });

  it('adds a full-width utility only when asked', () => {
    expect(buttonClasses({ fullWidth: true })).toContain('w-full');
    expect(buttonClasses()).not.toContain('w-full');
  });

  it('carries the one shared focus ring on every variant', () => {
    for (const variant of VARIANTS) {
      expect(buttonClasses({ variant })).toContain('focus-visible:ring-[var(--color-accent)]');
    }
  });

  it('never emits a raw hex colour — tokens only', () => {
    for (const variant of VARIANTS) {
      for (const size of SIZES) {
        const classes = buttonClasses({ variant, size });
        expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      }
    }
  });
});
