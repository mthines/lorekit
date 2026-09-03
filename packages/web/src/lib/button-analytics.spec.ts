import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MouseEvent as ReactMouseEvent } from 'react';

// `withButtonClickTracking` is a PURE wrapper: it fires the typed `track` event
// and delegates to the original handler. We mock `track` and assert the wire the
// wrapper produces — the same seam Button/IconButton use, tested without a DOM
// (the project installs no jsdom / testing-library; see useEditableForm.spec.ts).
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));

const { track } = await import('@/lib/analytics/track');
const { withButtonClickTracking } = await import('./button-analytics');

const trackMock = vi.mocked(track);

/** A stand-in click event — the wrapper only forwards it, never reads it. */
const fakeEvent = { type: 'click' } as unknown as ReactMouseEvent<HTMLButtonElement>;

beforeEach(() => {
  trackMock.mockReset();
});

describe('withButtonClickTracking', () => {
  it('emits ui.button_click then calls the original onClick when analyticsId is set', () => {
    const order: string[] = [];
    trackMock.mockImplementation(() => {
      order.push('track');
    });
    const onClick = vi.fn(() => {
      order.push('onClick');
    });

    const handler = withButtonClickTracking(onClick, {
      analyticsId: 'invite.accept',
      variant: 'primary',
      size: 'md',
    });
    handler?.(fakeEvent);

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith({
      name: 'ui.button_click',
      buttonId: 'invite.accept',
      variant: 'primary',
      size: 'md',
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(fakeEvent);
    // Tracking runs FIRST so a throwing/slow handler cannot suppress the event.
    expect(order).toEqual(['track', 'onClick']);
  });

  it('returns the original handler UNCHANGED when analyticsId is absent (no emit)', () => {
    const onClick = vi.fn();

    const handler = withButtonClickTracking(onClick, { variant: 'ghost', size: 'sm' });
    // Same reference — the button opts in by naming itself; untagged emits nothing.
    expect(handler).toBe(onClick);

    handler?.(fakeEvent);
    expect(trackMock).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('passes variant/size through as undefined when they are not set', () => {
    const handler = withButtonClickTracking(vi.fn(), { analyticsId: 'duplicate-clusters.close' });
    handler?.(fakeEvent);

    expect(trackMock).toHaveBeenCalledWith({
      name: 'ui.button_click',
      buttonId: 'duplicate-clusters.close',
      variant: undefined,
      size: undefined,
    });
  });

  it('still emits (and does not throw) when there is no original onClick', () => {
    const handler = withButtonClickTracking(undefined, { analyticsId: 'error.try-again' });

    expect(() => handler?.(fakeEvent)).not.toThrow();
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith({
      name: 'ui.button_click',
      buttonId: 'error.try-again',
      variant: undefined,
      size: undefined,
    });
  });

  it('returns undefined when neither analyticsId nor onClick is set', () => {
    expect(withButtonClickTracking(undefined, {})).toBeUndefined();
  });
});
