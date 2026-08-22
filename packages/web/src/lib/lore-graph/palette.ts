/**
 * The Lore Graph's colours, as linear floats a GPU attribute can take directly.
 *
 * The dashboard's palette lives in CSS custom properties (`--color-scope-*` in
 * `src/app/globals.css`) and every 2D surface reads it from there. A WebGL
 * material cannot: an instance-colour attribute is three floats per instance,
 * uploaded once, and resolving a CSS variable per node per upload would mean
 * `getComputedStyle` in a loop — a forced style recalculation 5,000 times over.
 *
 * So the values are mirrored here, in the one place, with `palette.spec.ts`
 * asserting the mirror still matches what `globals.css` declares. That is the
 * same guard the codebase already uses for its other unavoidable duplications
 * (`scope-parity.spec.ts`, `sections.spec.ts`): duplicate deliberately, then
 * make the duplication impossible to drift silently.
 */

import type { ScopePrefix } from '@/lib/scope';

/** An `[r, g, b]` triple in `[0, 1]` — the range a Three.js colour attribute wants. */
export type Rgb = readonly [number, number, number];

/**
 * The hex values mirrored from `globals.css`. Kept as strings rather than
 * pre-converted triples so the spec can compare them to the stylesheet as
 * written, character for character, instead of comparing to its own arithmetic.
 */
export const SCOPE_HEX: Record<ScopePrefix, string> = {
  global: '#a78bfa',
  project: '#34d399',
  repo: '#60a5fa',
  branch: '#f59e0b',
};

/** `--color-content-tertiary`: the skeleton edges, present but never loud. */
export const EDGE_HEX = '#4f5668';

/** `--color-accent`: LoreKit's amber, reserved for the current selection. */
export const SELECTION_HEX = '#f5a623';

/** `#rrggbb` → `[r, g, b]` in `[0, 1]`. Throws on anything else, loudly, at boot. */
export function hexToRgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

const SCOPE_RGB: Record<ScopePrefix, Rgb> = {
  global: hexToRgb(SCOPE_HEX.global),
  project: hexToRgb(SCOPE_HEX.project),
  repo: hexToRgb(SCOPE_HEX.repo),
  branch: hexToRgb(SCOPE_HEX.branch),
};

/** The colour for a scope type, defaulting to `global` for an unknown one. */
export function scopeRgb(type: ScopePrefix): Rgb {
  return SCOPE_RGB[type] ?? SCOPE_RGB.global;
}

/**
 * Move a colour toward black by `amount` (0 = unchanged, 1 = black).
 *
 * Used for archived memories. Dimming rather than greying keeps the scope hue
 * legible — an archived repo memory still reads as a repo memory, which matters
 * when the whole point of the view is telling clusters apart at a glance.
 */
export function dim(colour: Rgb, amount: number): Rgb {
  const keep = 1 - Math.min(Math.max(amount, 0), 1);
  return [colour[0] * keep, colour[1] * keep, colour[2] * keep];
}
