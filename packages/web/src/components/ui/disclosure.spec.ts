import { describe, it, expect } from 'vitest';
import { disclosureTriggerProps, disclosurePanelProps } from './disclosure';

describe('disclosure ARIA wiring', () => {
  it('reports the expanded state on the trigger', () => {
    expect(disclosureTriggerProps(true, 'panel-1')['aria-expanded']).toBe(true);
    expect(disclosureTriggerProps(false, 'panel-1')['aria-expanded']).toBe(false);
  });

  it('points the trigger at the panel it controls', () => {
    expect(disclosureTriggerProps(false, 'panel-1')['aria-controls']).toBe('panel-1');
  });

  it('hides the panel when closed and shows it when open', () => {
    expect(disclosurePanelProps(false, 'panel-1').hidden).toBe(true);
    expect(disclosurePanelProps(true, 'panel-1').hidden).toBe(false);
  });

  it('gives the panel the id the trigger references — in both states', () => {
    for (const open of [true, false]) {
      const trigger = disclosureTriggerProps(open, 'panel-1');
      const panel = disclosurePanelProps(open, 'panel-1');
      expect(panel.id).toBe(trigger['aria-controls']);
    }
  });

  it('keeps hidden the exact inverse of aria-expanded — they can never drift', () => {
    for (const open of [true, false]) {
      expect(disclosurePanelProps(open, 'p').hidden).toBe(
        !disclosureTriggerProps(open, 'p')['aria-expanded'],
      );
    }
  });
});
