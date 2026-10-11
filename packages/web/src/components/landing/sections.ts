/**
 * The home page's section heading ids — the single source for both the
 * headings themselves and the reading telemetry that bills time to them.
 *
 * `ReadingTelemetry` resolves "which section is the visitor in" by looking up
 * these ids in the DOM. A heading renamed in its component but not in the list
 * handed to telemetry would not error — it would simply stop appearing in
 * `content.section_read`, and the dashboard would show that section as unread.
 * Each section imports its id from here, so the two cannot drift.
 *
 * A plain module on purpose: `TerminalTheater` is a client component, and a
 * value exported from a `'use client'` file reaches a server component as a
 * client reference, not as the string.
 */
export const LANDING_SECTION_ID = {
  hero: 'hero-title',
  liveDemo: 'live-demo',
  problem: 'the-problem',
  howItWorks: 'how-it-works',
  whatYouGet: 'what-you-get',
  whereLoreLives: 'where-lore-lives',
  limitations: 'limitations',
  getStarted: 'get-started',
} as const;

/**
 * The same ids in DOCUMENT order — the order `app/page.tsx` renders them in.
 *
 * Order is load-bearing twice: the section resolver walks headings top to
 * bottom and stops at the first one below the reading line, and the position
 * in this list is what `content.section_read` reports as
 * `lorekit.content.section.index` ("did anyone reach section 6?"). Reorder the
 * page, reorder this list in the same change.
 */
export const LANDING_SECTION_ORDER = [
  LANDING_SECTION_ID.hero,
  LANDING_SECTION_ID.liveDemo,
  LANDING_SECTION_ID.problem,
  LANDING_SECTION_ID.howItWorks,
  LANDING_SECTION_ID.whatYouGet,
  LANDING_SECTION_ID.whereLoreLives,
  LANDING_SECTION_ID.limitations,
  LANDING_SECTION_ID.getStarted,
] as const;
