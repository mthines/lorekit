import { describe, expect, it } from 'vitest';

import { LANDING_SECTION_ID, LANDING_SECTION_ORDER } from './sections';

// The reading telemetry can only bill time to a section whose id is in the
// ORDER list, and it reports each section's position in that list. A section
// added to the id map but not to the order would be read on the page and
// invisible in the data — with no error anywhere — so that is what this pins.
describe('landing section ids', () => {
  it('lists every section in the reading order exactly once', () => {
    expect([...LANDING_SECTION_ORDER].sort()).toEqual(Object.values(LANDING_SECTION_ID).sort());
    expect(new Set(LANDING_SECTION_ORDER).size).toBe(LANDING_SECTION_ORDER.length);
  });

  it('starts with the hero and ends with the closing call to action', () => {
    expect(LANDING_SECTION_ORDER[0]).toBe(LANDING_SECTION_ID.hero);
    expect(LANDING_SECTION_ORDER[LANDING_SECTION_ORDER.length - 1]).toBe(LANDING_SECTION_ID.getStarted);
  });

  it('uses ids that are valid, stable DOM ids (lowercase kebab-case)', () => {
    for (const id of LANDING_SECTION_ORDER) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});
