import { describe, it, expect } from 'vitest';
import { isTypingTarget, nextLessonIndex } from './lesson-list-nav';

describe('nextLessonIndex', () => {
  it('moves to the next index on ArrowDown', () => {
    expect(nextLessonIndex(2, 'ArrowDown', 5)).toBe(3);
  });

  it('moves to the previous index on ArrowUp', () => {
    expect(nextLessonIndex(2, 'ArrowUp', 5)).toBe(1);
  });

  it('clamps at the last index — no wraparound', () => {
    expect(nextLessonIndex(4, 'ArrowDown', 5)).toBe(4);
  });

  it('clamps at the first index — no wraparound', () => {
    expect(nextLessonIndex(0, 'ArrowUp', 5)).toBe(0);
  });

  it('opens the first row on ArrowDown when nothing is selected yet', () => {
    expect(nextLessonIndex(null, 'ArrowDown', 5)).toBe(0);
  });

  it('opens the last row on ArrowUp when nothing is selected yet', () => {
    expect(nextLessonIndex(null, 'ArrowUp', 5)).toBe(4);
  });

  it('returns null for an empty list, regardless of key or current index', () => {
    expect(nextLessonIndex(null, 'ArrowDown', 0)).toBeNull();
    expect(nextLessonIndex(0, 'ArrowUp', 0)).toBeNull();
  });

  it('returns null for a non-arrow key', () => {
    expect(nextLessonIndex(2, 'Enter', 5)).toBeNull();
    expect(nextLessonIndex(2, 'a', 5)).toBeNull();
    expect(nextLessonIndex(null, 'Tab', 5)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('is false for no active element', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it('is true for each form-field tag', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const el = { tagName: tag } as unknown as Element;
      expect(isTypingTarget(el)).toBe(true);
    }
  });

  it('is true for a contentEditable element', () => {
    const el = { tagName: 'DIV', isContentEditable: true } as unknown as Element;
    expect(isTypingTarget(el)).toBe(true);
  });

  it('is false for an ordinary element', () => {
    const el = { tagName: 'BUTTON', isContentEditable: false } as unknown as Element;
    expect(isTypingTarget(el)).toBe(false);
    const div = { tagName: 'DIV' } as unknown as Element;
    expect(isTypingTarget(div)).toBe(false);
  });
});
