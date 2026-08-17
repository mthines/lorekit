import { describe, expect, it } from 'vitest';
import { crossedMilestones, dwellBucket, readPercent, resolveActiveHeadingId } from './reading';

describe('readPercent', () => {
  const base = { contentTop: 200, contentHeight: 2000, scrollY: 0, viewportHeight: 800 };

  it('measures against the CONTENT, not the document', () => {
    // Viewport bottom at 800 ⇒ 600px of the 2000px article seen ⇒ 30%.
    expect(readPercent(base)).toBeCloseTo(30);
  });

  it('clamps below the article to 0 rather than reporting negative depth', () => {
    expect(readPercent({ ...base, contentTop: 5000 })).toBe(0);
  });

  it('clamps past the end to 100, so a long footer cannot exceed the scale', () => {
    expect(readPercent({ ...base, scrollY: 9000 })).toBe(100);
  });

  it('treats an article shorter than the viewport as fully seen', () => {
    // 300px of article, viewport bottom already 600px past its top.
    expect(readPercent({ ...base, contentHeight: 300 })).toBe(100);
  });

  it('reports an UNMEASURABLE height as 0, not as a complete read', () => {
    // A height of 0 means "not laid out yet", not "all of it was on screen".
    // The caller keeps a running maximum, so a spurious 100 here would pin
    // `completed` true for the whole page view and can never be walked back.
    expect(readPercent({ ...base, contentHeight: 0 })).toBe(0);
    expect(readPercent({ ...base, contentHeight: -10 })).toBe(0);
  });
});

describe('crossedMilestones', () => {
  it('reports only the milestones newly crossed', () => {
    expect(crossedMilestones(20, 30)).toEqual([25]);
  });

  it('reports every milestone a JUMP skipped, keeping the funnel monotonic', () => {
    expect(crossedMilestones(0, 100)).toEqual([25, 50, 75, 100]);
  });

  it('never re-reports after scrolling up and back down', () => {
    // The caller passes the previous MAXIMUM — this is what makes that matter.
    expect(crossedMilestones(75, 30)).toEqual([]);
  });
});

describe('dwellBucket', () => {
  it('orders lexically the way it orders in time', () => {
    const labels = [0, 6_000, 20_000, 90_000, 400_000].map(dwellBucket);
    expect(labels).toEqual([...labels].sort());
  });

  it('puts a glance and a real read in different buckets', () => {
    expect(dwellBucket(4_999)).toBe('1_under_5s');
    expect(dwellBucket(5_000)).toBe('2_5_15s');
    expect(dwellBucket(60_000)).toBe('4_1_3m');
  });
});

describe('resolveActiveHeadingId', () => {
  const positions = [
    { id: 'intro', top: -400 },
    { id: 'middle', top: 60 },
    { id: 'end', top: 900 },
  ];

  it('is the last heading above the reading line', () => {
    expect(resolveActiveHeadingId(positions, { offset: 128, atBottom: false })).toBe('middle');
  });

  it('falls back to the first heading before anything has scrolled past', () => {
    const below = positions.map((p) => ({ ...p, top: p.top + 1000 }));
    expect(resolveActiveHeadingId(below, { offset: 128, atBottom: false })).toBe('intro');
  });

  it('gives the page bottom to the LAST section, whose heading never reaches the line', () => {
    expect(resolveActiveHeadingId(positions, { offset: 128, atBottom: true })).toBe('end');
  });

  it('returns an empty id for a page with no headings rather than throwing', () => {
    expect(resolveActiveHeadingId([], { offset: 128, atBottom: true })).toBe('');
  });
});
