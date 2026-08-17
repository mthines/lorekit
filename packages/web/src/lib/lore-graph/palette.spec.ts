import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dim, EDGE_HEX, hexToRgb, SCOPE_HEX, scopeRgb, SELECTION_HEX } from './palette';

/** `globals.css` as written — the source these constants mirror. */
const globalsCss = readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8');

/** The declared value of a `--color-*` custom property. */
function cssToken(name: string): string | null {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(globalsCss);
  return match ? match[1].toLowerCase() : null;
}

describe('palette', () => {
  // A WebGL attribute cannot read a CSS custom property, so these values are
  // mirrored by hand. This suite is what stops the mirror drifting: change
  // `globals.css` without changing `palette.ts` and it goes red here rather
  // than shipping a graph in last quarter's colours.
  it.each(['global', 'project', 'repo', 'branch'] as const)(
    'mirrors --color-scope-%s from globals.css',
    (type) => {
      expect(SCOPE_HEX[type].toLowerCase()).toBe(cssToken(`scope-${type}`));
    },
  );

  it('mirrors --color-content-tertiary for edges', () => {
    expect(EDGE_HEX.toLowerCase()).toBe(cssToken('content-tertiary'));
  });

  it('mirrors --color-accent for the selection', () => {
    expect(SELECTION_HEX.toLowerCase()).toBe(cssToken('accent'));
  });
});

describe('hexToRgb', () => {
  it('normalises each channel into [0, 1]', () => {
    expect(hexToRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
  });

  it('keeps the channels in r, g, b order', () => {
    const [r, g, b] = hexToRgb('#ff8000');
    expect(r).toBe(1);
    expect(g).toBeCloseTo(128 / 255, 5);
    expect(b).toBe(0);
  });

  it('is case-insensitive and tolerates padding', () => {
    expect(hexToRgb('  #A78BFA  ')).toEqual(hexToRgb('#a78bfa'));
  });

  it('throws on anything that is not a 6-digit hex colour', () => {
    expect(() => hexToRgb('#abc')).toThrow(/hex colour/);
    expect(() => hexToRgb('rebeccapurple')).toThrow(/hex colour/);
  });
});

describe('scopeRgb', () => {
  it('gives each scope type its own colour', () => {
    const colours = (['global', 'project', 'repo', 'branch'] as const).map((t) => scopeRgb(t).join());
    expect(new Set(colours).size).toBe(4);
  });
});

describe('dim', () => {
  it('keeps the hue while darkening — an archived repo memory still reads as repo', () => {
    const repo = scopeRgb('repo');
    const dimmed = dim(repo, 0.5);

    expect(dimmed[0] / dimmed[2]).toBeCloseTo(repo[0] / repo[2], 5);
    expect(dimmed[2]).toBeLessThan(repo[2]);
  });

  it('clamps out-of-range amounts instead of producing negative light', () => {
    expect(dim([1, 1, 1], 2)).toEqual([0, 0, 0]);
    expect(dim([1, 1, 1], -1)).toEqual([1, 1, 1]);
  });
});
