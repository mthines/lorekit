import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MATRIX_COL,
  DEFAULT_MATRIX_ROW,
  MATRIX_AXES,
  brushRange,
  buildMatrixGrid,
  cellKey,
  dayIndexAt,
  heatStep,
} from './explorer-instruments';
import type { PivotCell } from '@lorekit/schemas/memory';

const cell = (row: string, col: string, count: number): PivotCell => ({ row, col, count });

describe('MATRIX_AXES', () => {
  it('offers every filter dimension except the pull-request identifier', () => {
    const fields = MATRIX_AXES.map((a) => a.field);
    expect(fields).toContain('label');
    expect(fields).toContain('host');
    expect(fields).toContain('owner');
    // A PR number is a high-cardinality identifier: an axis of it is hundreds
    // of columns holding one cell each, which is not a grid anyone can read.
    expect(fields).not.toContain('pr');
  });

  it('names the API facet for each axis, so a request cannot invent a dimension', () => {
    for (const axis of MATRIX_AXES) {
      expect(axis.facet).toBeTruthy();
      expect(axis.label).toBeTruthy();
    }
    expect(MATRIX_AXES.find((a) => a.field === 'label')?.facet).toBe('tag');
  });

  it('opens on a pair that is actually offered', () => {
    const fields = MATRIX_AXES.map((a) => a.field);
    expect(fields).toContain(DEFAULT_MATRIX_ROW);
    expect(fields).toContain(DEFAULT_MATRIX_COL);
  });
});

describe('buildMatrixGrid', () => {
  it('orders both axes densest first', () => {
    const grid = buildMatrixGrid([
      cell('a', 'x', 1),
      cell('b', 'x', 9),
      cell('b', 'y', 3),
    ]);
    expect(grid.rows).toEqual(['b', 'a']);
    expect(grid.cols).toEqual(['x', 'y']);
    expect(grid.max).toBe(9);
  });

  it('breaks ties alphabetically, so equal responses do not reshuffle the grid', () => {
    const grid = buildMatrixGrid([cell('b', 'x', 5), cell('a', 'x', 5)]);
    expect(grid.rows).toEqual(['a', 'b']);
  });

  it('omits pairs the endpoint did not return, rather than storing zeroes', () => {
    const grid = buildMatrixGrid([cell('a', 'x', 2)]);
    expect(grid.counts.get(cellKey('a', 'x'))).toBe(2);
    expect(grid.counts.has(cellKey('a', 'y'))).toBe(false);
  });

  it('caps each axis and reports that it did', () => {
    const cells = Array.from({ length: 20 }, (_, i) => cell(`r${i}`, 'x', 20 - i));
    const grid = buildMatrixGrid(cells, { rowsMax: 3 });
    expect(grid.rows).toEqual(['r0', 'r1', 'r2']);
    expect(grid.truncated).toBe(true);
  });

  it('carries the endpoint\'s own truncation through', () => {
    const grid = buildMatrixGrid([cell('a', 'x', 1)], { truncated: true });
    expect(grid.truncated).toBe(true);
  });

  it('is empty-safe', () => {
    const grid = buildMatrixGrid([]);
    expect(grid.rows).toEqual([]);
    expect(grid.cols).toEqual([]);
    expect(grid.max).toBe(0);
    expect(grid.truncated).toBe(false);
  });

  it('drops cells whose row or column fell outside the cap', () => {
    const grid = buildMatrixGrid(
      [cell('keep', 'x', 10), cell('drop', 'x', 1)],
      { rowsMax: 1 },
    );
    expect(grid.counts.has(cellKey('drop', 'x'))).toBe(false);
    // The scale must describe what is DRAWN, or the darkest cell on screen is
    // not the top of the ramp.
    expect(grid.max).toBe(10);
  });
});

describe('heatStep', () => {
  it('distinguishes empty from the ramp\'s first step', () => {
    expect(heatStep(0, 10, 5)).toBe(-1);
    expect(heatStep(1, 10, 5)).toBeGreaterThanOrEqual(0);
  });

  it('puts the maximum on the last step', () => {
    expect(heatStep(10, 10, 5)).toBe(4);
  });

  it('spreads the low end, which a linear ramp flattens into the ground', () => {
    // 1/100 is 1% of the max: a linear ramp floors it at step 0 along with the
    // whole tail. Rooting it lifts it clear.
    expect(heatStep(1, 100, 10)).toBeGreaterThan(0);
  });

  it('never exceeds the ramp', () => {
    expect(heatStep(999, 10, 5)).toBe(4);
    expect(heatStep(5, 0, 5)).toBe(-1);
  });
});

describe('brushRange', () => {
  it('normalises a right-to-left drag', () => {
    expect(brushRange('2026-08-20', '2026-08-10')).toEqual({
      from: '2026-08-10',
      to: '2026-08-20',
    });
  });

  it('leaves a left-to-right drag alone', () => {
    expect(brushRange('2026-08-10', '2026-08-20')).toEqual({
      from: '2026-08-10',
      to: '2026-08-20',
    });
  });

  it('supports a single-day brush (a tap)', () => {
    expect(brushRange('2026-08-10', '2026-08-10')).toEqual({
      from: '2026-08-10',
      to: '2026-08-10',
    });
  });
});

describe('dayIndexAt', () => {
  it('maps the left edge to the first day and the right edge to the last', () => {
    expect(dayIndexAt(0, 100, 10)).toBe(0);
    // The right EDGE is exclusive in ratio terms, so without the clamp this
    // lands one past the end and silently drops the most recent day — the one a
    // reader is most likely aiming at.
    expect(dayIndexAt(100, 100, 10)).toBe(9);
    expect(dayIndexAt(99.9, 100, 10)).toBe(9);
  });

  it('clamps a pointer dragged outside the track', () => {
    // A pointer capture keeps sending moves after the pointer leaves.
    expect(dayIndexAt(-40, 100, 10)).toBe(0);
    expect(dayIndexAt(400, 100, 10)).toBe(9);
  });

  it('is degenerate-safe', () => {
    expect(dayIndexAt(50, 0, 10)).toBe(0);
    expect(dayIndexAt(50, 100, 0)).toBe(0);
  });
});
