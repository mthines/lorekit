'use client';

/**
 * The active-item cursor every chart on the visual Insights page shares — the
 * same interaction contract `Sparkbar` established, factored out so the Pulse
 * timeline and the runs swimlanes behave identically:
 *
 *   - ONE tab stop per chart; arrow keys / Home / End walk the items
 *     (`nextIndex`), Escape clears, blur clears.
 *   - Pointer hover activates (not on touch); a tap toggles and persists, and a
 *     pointer-down outside the chart dismisses it.
 *   - Item ELEMENTS are kept (not rects) so the portaled readout can re-measure
 *     its anchor on scroll.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { nextIndex } from '@/components/dashboard/Sparkbar';

export function useChartCursor(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(Element | null)[]>([]);

  const dismiss = useCallback(() => setActive(null), []);

  useEffect(() => {
    function onDown(e: globalThis.PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setActive(null);
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  // A window change can shrink the series under an active index.
  useEffect(() => {
    setActive((a) => (a !== null && a >= count ? null : a));
  }, [count]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActive(null);
        return;
      }
      const next = nextIndex(active, e.key, count);
      if (next === null) return;
      e.preventDefault();
      setActive(next);
    },
    [active, count],
  );

  /** Pointer + click handlers for item `i`. */
  const itemHandlers = useCallback(
    (i: number) => ({
      onPointerEnter: (e: PointerEvent) => {
        if (e.pointerType !== 'touch') setActive(i);
      },
      onPointerLeave: (e: PointerEvent) => {
        if (e.pointerType !== 'touch') setActive((a) => (a === i ? null : a));
      },
      onClick: () => setActive((a) => (a === i ? null : i)),
    }),
    [],
  );

  const itemRef = useCallback(
    (i: number) => (el: Element | null) => {
      itemRefs.current[i] = el;
    },
    [],
  );

  return {
    active,
    setActive,
    dismiss,
    rootRef,
    anchor: active === null ? null : (itemRefs.current[active] ?? null),
    itemRef,
    itemHandlers,
    rootProps: { tabIndex: 0, onKeyDown, onBlur: dismiss },
  };
}
