'use client';

/**
 * FadeScroller — a horizontally scrolling row whose overflowing edges fade, and
 * only on the side that still has content to scroll to.
 *
 * A row of chips or tabs that outgrows its width has to become scrollable on a
 * phone, but a bare `overflow-x-auto` gives the reader no sign that there is
 * more off-screen — the last visible item is simply clipped at a hard edge that
 * reads as "the end". A static gradient on both edges is the opposite mistake:
 * it vignettes a row that already fits and fades the first item when there is
 * nothing to the left of it.
 *
 * This measures the scroll position and masks the start edge only once scrolled
 * away from 0, and the end edge only while more content remains — so the fade is
 * an honest "there is more this way", present exactly when it is true.
 *
 * ## Contract for tests / styling
 * The scroll element carries `data-fade-start` / `data-fade-end` (`"true"` |
 * `"false"`), so the fade STATE is assertable without reading a computed
 * `mask-image`. Any `role` / `aria-*` / `id` / `className` passed through lands
 * on that same scroll element (it `extends HTMLAttributes`), so a consumer can,
 * e.g., make it a `radiogroup` — the scroll container and the semantic group are
 * one element.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

/** Width of each edge fade, px — enough to read as "more here", not a vignette. */
const DEFAULT_FADE_PX = 24;

interface FadeScrollerProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Width of each edge fade, in px. */
  fadePx?: number;
}

export function FadeScroller({
  children,
  fadePx = DEFAULT_FADE_PX,
  className = '',
  style,
  ...rest
}: FadeScrollerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    // `ceil` guards a sub-pixel `scrollWidth` from reporting a phantom pixel of
    // remaining scroll on a row that is actually at its end.
    const end = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1;
    // Bail when unchanged so the every-commit `useLayoutEffect` below cannot
    // loop: a new object identity would re-render → re-measure → re-render.
    setFade((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // Re-measure after every commit. This is the only signal that catches CONTENT
  // growth — chips loading in widen `scrollWidth` without changing the element's
  // own box, so a ResizeObserver alone would miss it. Cheap: the guarded
  // `setFade` bails when nothing changed.
  useLayoutEffect(measure);

  // Interaction + the element's own resize.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [measure]);

  const maskImage = `linear-gradient(to right, ${
    fade.start ? 'transparent' : 'black'
  } 0, black ${fadePx}px, black calc(100% - ${fadePx}px), ${
    fade.end ? 'transparent' : 'black'
  } 100%)`;

  return (
    <div
      ref={ref}
      data-fade-start={fade.start ? 'true' : 'false'}
      data-fade-end={fade.end ? 'true' : 'false'}
      className={`flex overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
      style={{ maskImage, WebkitMaskImage: maskImage, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}
