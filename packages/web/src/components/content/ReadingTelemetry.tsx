'use client';

import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/track';
import {
  crossedMilestones,
  readPercent,
  resolveActiveHeadingId,
  type ContentType,
} from '@/lib/analytics/reading';

/**
 * Reading-engagement RUM for a long-form page. Renders nothing.
 *
 * Answers three questions the existing telemetry cannot:
 * - **How far did they get?** `content.scroll_depth` at 25/50/75/100 % of the
 *   ARTICLE (not the document — see `readPercent`).
 * - **Which sections held them?** `content.section_read` when a reader leaves a
 *   section, carrying the time they spent in it.
 * - **Did they actually read it?** `content.read`, one summary per page view.
 *
 * ## Engaged time, not wall-clock time
 * Time only accrues while the tab is VISIBLE and the reader has interacted
 * within {@link IDLE_AFTER_MS}. A post left open in a background tab overnight
 * is worth zero, which is the whole point: an un-gated "time on page" ranks
 * abandoned tabs above real readers.
 *
 * ## Emit early, summarise late
 * Milestones and section events are emitted the moment they happen, because the
 * end-of-page-view flush is the one thing that can be lost — the SDK batcher
 * registers its own `visibilitychange` flush at init, so it runs BEFORE ours and
 * the summary rides out on a later flush (`pagehide` / `beforeunload`) that a
 * killed mobile tab may never give us. Treat `content.read` as the richer but
 * lossier signal and `content.scroll_depth` as the one you build funnels on.
 *
 * ## Cost
 * One rAF-throttled passive `scroll` listener and one 1 s interval. No layout
 * thrash beyond a `getBoundingClientRect` per frame that scrolls.
 */

/** No interaction for this long ⇒ the reader is gone; stop billing time. */
const IDLE_AFTER_MS = 30_000;

/** Accrual granularity. 1 s is finer than any bucket boundary and free. */
const TICK_MS = 1_000;

/** Below this, a "section read" is scroll-through, not reading. Don't emit it. */
const MIN_SECTION_DWELL_MS = 1_000;

/**
 * The reading line, px from the viewport top. Must match `useActiveHeading`'s
 * `ACTIVE_OFFSET` — the section we bill time to is the one the TOC lights up.
 */
const ACTIVE_OFFSET = 128;

export interface ReadingTelemetryProps {
  /** Which surface this is. Bounded — `blog` | `docs` | `learn`. */
  contentType: ContentType;
  /** The page's slug. Bounded by the MDX files on disk, so safe as an attribute. */
  slug: string;
  /** Heading ids in document order — pass `post.toc.map((i) => i.id)`. */
  sectionIds: readonly string[];
  /** Element whose height defines "the content". Defaults to the article. */
  contentSelector?: string;
}

export function ReadingTelemetry({
  contentType,
  slug,
  sectionIds,
  contentSelector = 'article',
}: ReadingTelemetryProps) {
  // Refs, not state: every value here is written from listeners and read at
  // flush time. None of it should ever cause a render.
  const maxDepth = useRef(0);
  const engagedMs = useRef(0);
  const sectionsRead = useRef(new Set<string>());
  const currentSection = useRef('');
  const currentSectionMs = useRef(0);
  const topSection = useRef<{ id: string; ms: number } | null>(null);
  const lastInteractionAt = useRef(0);
  const lastTickAt = useRef(0);
  const summarised = useRef(false);

  // The effect depends on the section list by VALUE, not by identity: a parent
  // that passes `post.toc.map((i) => i.id)` inline would otherwise hand us a new
  // array every render and tear the whole listener set down with it.
  const sectionKey = sectionIds.join('|');

  useEffect(() => {
    const sections = sectionKey ? sectionKey.split('|') : [];
    const content = document.querySelector(contentSelector);
    if (!(content instanceof HTMLElement)) return;

    const now = () => Date.now();
    lastInteractionAt.current = now();
    lastTickAt.current = now();

    const activeSectionId = (): string => {
      const positions = sections
        .map((id) => {
          const el = document.getElementById(id);
          return el ? { id, top: el.getBoundingClientRect().top } : null;
        })
        .filter((p): p is { id: string; top: number } => p !== null);
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      return resolveActiveHeadingId(positions, { offset: ACTIVE_OFFSET, atBottom });
    };

    /**
     * Emit the section the reader is leaving. Re-entering a section later emits
     * a SECOND event rather than resuming the first — summing `dwell_ms` per
     * section is the correct aggregation either way, and it keeps the emit path
     * stateless enough to survive a lost flush.
     */
    const closeSection = () => {
      const id = currentSection.current;
      const ms = Math.round(currentSectionMs.current);
      currentSection.current = '';
      currentSectionMs.current = 0;
      if (!id || ms < MIN_SECTION_DWELL_MS) return;
      sectionsRead.current.add(id);
      if (ms > (topSection.current?.ms ?? 0)) topSection.current = { id, ms };
      track({
        name: 'content.section_read',
        contentType,
        slug,
        sectionId: id,
        sectionIndex: sections.indexOf(id),
        dwellMs: ms,
      });
    };

    const tick = () => {
      const at = now();
      const elapsed = at - lastTickAt.current;
      lastTickAt.current = at;
      if (document.visibilityState !== 'visible') return;
      if (at - lastInteractionAt.current > IDLE_AFTER_MS) return;

      engagedMs.current += elapsed;
      const id = activeSectionId();
      if (id !== currentSection.current) {
        closeSection();
        currentSection.current = id;
      }
      currentSectionMs.current += elapsed;
    };

    let frame = 0;
    const onScroll = () => {
      lastInteractionAt.current = now();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = content.getBoundingClientRect();
        const percent = readPercent({
          contentTop: rect.top + window.scrollY,
          contentHeight: rect.height,
          scrollY: window.scrollY,
          viewportHeight: window.innerHeight,
        });
        for (const depthPercent of crossedMilestones(maxDepth.current, percent)) {
          track({ name: 'content.scroll_depth', contentType, slug, depthPercent });
        }
        maxDepth.current = Math.max(maxDepth.current, percent);
      });
    };

    const markInteraction = () => {
      lastInteractionAt.current = now();
    };

    /** One summary per page view, at the FIRST of (tab hidden, unmount). */
    const summarise = () => {
      if (summarised.current) return;
      summarised.current = true;
      tick(); // bank the partial tick
      closeSection(); // and the section in progress
      track({
        name: 'content.read',
        contentType,
        slug,
        maxDepthPercent: Math.round(maxDepth.current),
        engagedMs: Math.round(engagedMs.current),
        sectionsRead: sectionsRead.current.size,
        topSectionId: topSection.current?.id,
        completed: maxDepth.current >= 100,
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') summarise();
    };

    const interval = window.setInterval(tick, TICK_MS);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('pointerdown', markInteraction, { passive: true });
    window.addEventListener('keydown', markInteraction);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', summarise);

    onScroll(); // above-the-fold depth, before the reader touches anything

    return () => {
      // A client-side navigation to the next post unmounts us without ever
      // firing `pagehide`, so the summary has to happen here too.
      summarise();
      window.clearInterval(interval);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('pointerdown', markInteraction);
      window.removeEventListener('keydown', markInteraction);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', summarise);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [contentType, slug, sectionKey, contentSelector]);

  return null;
}
