import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real SDK never runs in a unit test, but the WIRE SHAPE does: this
// stand-in records exactly what `track()` hands `sendEvent`, which is the only
// thing this module is responsible for. Mirrors `lib/dash0-rum.spec.ts`'s
// stand-in rather than a bare `vi.fn()` so a spec can assert the second
// argument's structure, not merely that a call happened — and it can be told
// to THROW, because "telemetry never breaks the UI" is a claim in the module's
// docblock and an unthrowing stub would assert nothing about it.
vi.mock('@dash0/sdk-web', () => {
  const calls: Array<{ name: string; attributes: Record<string, string> }> = [];
  const state = { throwNext: false };
  return {
    sendEvent: (name: string, options: { attributes: Record<string, string> }) => {
      if (state.throwNext) {
        state.throwNext = false;
        throw new Error('sdk-web is not initialised');
      }
      calls.push({ name, attributes: options.attributes });
    },
    __calls: calls,
    __state: state,
  };
});

const { track, normalizeCommandId } = await import('./track');

const { __calls: calls, __state: state } = (await import('@dash0/sdk-web')) as unknown as {
  __calls: Array<{ name: string; attributes: Record<string, string> }>;
  __state: { throwNext: boolean };
};

const lastCall = () => calls[calls.length - 1]!;

beforeEach(() => {
  calls.length = 0;
  state.throwNext = false;
});

describe('track — install_command.copied', () => {
  it('maps a FAILED copy onto lorekit.install_command.succeeded = "false"', () => {
    track({
      name: 'install_command.copied',
      commandId: 'cli-install',
      surface: 'login-get-started',
      succeeded: false,
    });

    expect(calls.length).toBe(1);
    expect(lastCall().name).toBe('install_command.copied');
    expect(lastCall().attributes).toEqual({
      'lorekit.install_command.id': 'cli-install',
      'lorekit.install_command.surface': 'login-get-started',
      'lorekit.install_command.succeeded': 'false',
    });
  });

  it('maps a successful copy onto "true"', () => {
    track({
      name: 'install_command.copied',
      commandId: 'cli-install',
      surface: 'login-get-started',
      succeeded: true,
    });

    expect(lastCall().attributes['lorekit.install_command.succeeded']).toBe('true');
  });

  it('emits the succeeded attribute for a FALSE value rather than omitting it', () => {
    // The regression this pins: `command_palette.command_selected` deliberately
    // drops an absent `group` with `if (event.group)`. The same idiom applied to
    // a boolean would silently drop every FAILURE — the one outcome this event
    // exists to record — and the remaining rows would all read `true`, which is
    // indistinguishable from a clipboard that never fails.
    track({
      name: 'install_command.copied',
      commandId: 'cli-install',
      surface: 'login-get-started',
      succeeded: false,
    });

    expect(Object.keys(lastCall().attributes)).toContain('lorekit.install_command.succeeded');
  });

  it('sends bounded lorekit.* ids only — never the command string', () => {
    track({
      name: 'install_command.copied',
      commandId: 'cli-install',
      surface: 'login-get-started',
      succeeded: true,
    });

    const attributes = lastCall().attributes;
    expect(Object.keys(attributes).every((key) => key.startsWith('lorekit.install_command.'))).toBe(
      true,
    );
    expect(Object.values(attributes)).not.toContain('npx @lorekit/cli install');
  });
});

describe('track — command palette events', () => {
  it('maps command_palette.opened onto its trigger attribute', () => {
    track({ name: 'command_palette.opened', trigger: 'shortcut' });

    expect(lastCall().name).toBe('command_palette.opened');
    expect(lastCall().attributes).toEqual({ 'lorekit.command_palette.trigger': 'shortcut' });
  });

  it('omits lorekit.command.group when the command has no group', () => {
    track({ name: 'command_palette.command_selected', commandId: 'lore-open', source: 'palette' });

    expect(lastCall().attributes).toEqual({
      'lorekit.command.id': 'lore-open',
      'lorekit.command.source': 'palette',
    });
  });

  it('buckets a dynamic lesson command id so a lesson key is never sent', () => {
    track({
      name: 'command_palette.command_selected',
      commandId: 'lore-lesson-repo::mthines/lorekit::some-secret-key',
      source: 'palette',
      group: 'Lore',
    });

    expect(lastCall().attributes['lorekit.command.id']).toBe('lore-lesson');
    expect(lastCall().attributes['lorekit.command.group']).toBe('Lore');
  });
});

describe('normalizeCommandId', () => {
  it('collapses every dynamic lesson id onto one bucket', () => {
    expect(normalizeCommandId('lore-lesson-global::foo')).toBe('lore-lesson');
  });

  it('passes a static command id through unchanged', () => {
    expect(normalizeCommandId('settings-open')).toBe('settings-open');
  });
});

describe('track — ui.button_click', () => {
  it('maps buttonId + variant + size onto the lorekit.ui.* attributes', () => {
    track({ name: 'ui.button_click', buttonId: 'invite.accept', variant: 'primary', size: 'sm' });

    expect(calls.length).toBe(1);
    expect(lastCall().name).toBe('ui.button_click');
    expect(lastCall().attributes).toEqual({
      'lorekit.ui.button_id': 'invite.accept',
      'lorekit.ui.button_variant': 'primary',
      'lorekit.ui.button_size': 'sm',
    });
  });

  it('omits variant and size when they are not set', () => {
    track({ name: 'ui.button_click', buttonId: 'duplicate-clusters.close' });

    expect(lastCall().attributes).toEqual({
      'lorekit.ui.button_id': 'duplicate-clusters.close',
    });
    expect(Object.keys(lastCall().attributes)).not.toContain('lorekit.ui.button_variant');
    expect(Object.keys(lastCall().attributes)).not.toContain('lorekit.ui.button_size');
  });

  it('sends only bounded lorekit.ui.* attributes (the id is a static slug)', () => {
    track({ name: 'ui.button_click', buttonId: 'org.delete', variant: 'danger-outline' });

    const attributes = lastCall().attributes;
    expect(Object.keys(attributes).every((key) => key.startsWith('lorekit.ui.'))).toBe(true);
    expect(attributes['lorekit.ui.button_id']).toBe('org.delete');
    expect(attributes['lorekit.ui.button_variant']).toBe('danger-outline');
  });
});

describe('track — best effort', () => {
  it('swallows an SDK failure instead of breaking the caller', () => {
    state.throwNext = true;

    expect(() =>
      track({
        name: 'install_command.copied',
        commandId: 'cli-install',
        surface: 'login-get-started',
        succeeded: false,
      }),
    ).not.toThrow();
    expect(calls.length).toBe(0);
  });
});

// ── Lore Explorer ───────────────────────────────────────────────────────────
//
// The property every assertion below is really pinning: NO attribute on a
// `lore.*` event carries a scope, a memory key, a filter value or a search
// term. The Explorer is the one page where almost everything a reader touches
// is their own content, so each event's job is to answer "what kind of thing
// happened" without recording which thing it happened to.

describe('track — lore.memory_opened', () => {
  it('records the surface and the scope TYPE, never the scope', () => {
    track({ name: 'lore.memory_opened', surface: 'lore-list', scopeType: 'repo', index: 3 });

    expect(lastCall().name).toBe('lore.memory_opened');
    expect(lastCall().attributes).toEqual({
      'lorekit.lore.memory.surface': 'lore-list',
      'lorekit.lore.memory.scope_type': 'repo',
      'lorekit.lore.memory.index': 3,
    });
  });

  it('keeps the five opening surfaces apart', () => {
    for (const surface of ['lore-list', 'lore-cluster', 'lore-keyboard', 'command-palette', 'header-recents'] as const) {
      track({ name: 'lore.memory_opened', surface, scopeType: 'global' });
      expect(lastCall().attributes['lorekit.lore.memory.surface']).toBe(surface);
    }
  });

  // A caller with no list position (the palette, the header dropdown) must not
  // land a sentinel that would sort ahead of row 0 in every percentile.
  it('omits the index when the opener has no list position', () => {
    track({ name: 'lore.memory_opened', surface: 'command-palette', scopeType: 'branch' });
    expect(lastCall().attributes['lorekit.lore.memory.index']).toBeUndefined();
  });

  it('records row 0 rather than dropping it as falsy', () => {
    track({ name: 'lore.memory_opened', surface: 'lore-list', scopeType: 'project', index: 0 });
    expect(lastCall().attributes['lorekit.lore.memory.index']).toBe(0);
  });
});

describe('track — lore.memory_closed', () => {
  it('carries why the panel closed', () => {
    track({ name: 'lore.memory_closed', reason: 'filter-change' });
    expect(lastCall().attributes).toEqual({
      'lorekit.lore.memory.close_reason': 'filter-change',
    });
  });
});

describe('track — lore.memory_edit', () => {
  it('reports which of the three fields moved, false included', () => {
    track({
      name: 'lore.memory_edit',
      action: 'save',
      outcome: 'success',
      changedValue: false,
      changedTags: true,
      changedTtl: false,
    });

    expect(lastCall().attributes).toEqual({
      'lorekit.lore.memory.edit_action': 'save',
      'lorekit.lore.memory.edit_outcome': 'success',
      // Strings, and present for a `false` — "the body did NOT change on this
      // save" is the finding, and an omitted attribute cannot be grouped by.
      'lorekit.lore.memory.changed_value': 'false',
      'lorekit.lore.memory.changed_tags': 'true',
      'lorekit.lore.memory.changed_ttl': 'false',
    });
  });

  it('records a failed save as an outcome rather than as silence', () => {
    track({
      name: 'lore.memory_edit',
      action: 'save',
      outcome: 'error',
      changedValue: true,
      changedTags: false,
      changedTtl: false,
    });
    expect(lastCall().attributes['lorekit.lore.memory.edit_outcome']).toBe('error');
  });

  it('omits the outcome on a discard, which has none', () => {
    track({ name: 'lore.memory_edit', action: 'discard' });
    expect(lastCall().attributes).toEqual({ 'lorekit.lore.memory.edit_action': 'discard' });
  });
});

describe('track — lore.memory_archive_toggled', () => {
  it('keeps the direction and the outcome apart', () => {
    track({ name: 'lore.memory_archive_toggled', action: 'restore', outcome: 'error' });
    expect(lastCall().attributes).toEqual({
      'lorekit.lore.memory.archive_action': 'restore',
      'lorekit.lore.memory.archive_outcome': 'error',
    });
  });
});

describe('track — lore.filter_changed', () => {
  it('sends the dimension and the operator, never the value', () => {
    track({
      name: 'lore.filter_changed',
      action: 'operator',
      field: 'label',
      operator: 'all',
      filterCount: 2,
      retentionCount: 0,
    });

    expect(lastCall().attributes).toEqual({
      'lorekit.lore.filter.action': 'operator',
      'lorekit.lore.filter.field': 'label',
      'lorekit.lore.filter.operator': 'all',
      'lorekit.lore.filter.count': 2,
      'lorekit.lore.filter.retention_count': 0,
    });
  });

  it('omits the field on a clear-all, which touches every dimension', () => {
    track({ name: 'lore.filter_changed', action: 'clear-all', filterCount: 0, retentionCount: 0 });
    expect(lastCall().attributes['lorekit.lore.filter.field']).toBeUndefined();
    // The counts stay, and a zero is a row: "the bar is now empty" is the fact.
    expect(lastCall().attributes['lorekit.lore.filter.count']).toBe(0);
  });
});

describe('track — lore.search_committed', () => {
  // The single most content-bearing thing typed on this page. Only its length
  // may leave the browser.
  it('sends the query LENGTH and nothing else', () => {
    track({ name: 'lore.search_committed', queryLength: 11 });
    expect(lastCall().attributes).toEqual({ 'lorekit.lore.search.length': 11 });
  });

  it('sends a zero for a cleared box rather than omitting it', () => {
    track({ name: 'lore.search_committed', queryLength: 0 });
    expect(lastCall().attributes['lorekit.lore.search.length']).toBe(0);
  });
});

describe('track — lore.range_changed', () => {
  it('names which of the five controls wrote the range', () => {
    track({ name: 'lore.range_changed', preset: 'custom', source: 'timeline-brush', spanDays: 21 });
    expect(lastCall().attributes).toEqual({
      'lorekit.lore.range.preset': 'custom',
      'lorekit.lore.range.source': 'timeline-brush',
      'lorekit.lore.range.span_days': 21,
    });
  });

  it('omits the span for an unbounded window', () => {
    track({ name: 'lore.range_changed', preset: 'all', source: 'empty-state' });
    expect(lastCall().attributes['lorekit.lore.range.span_days']).toBeUndefined();
  });
});

describe('track — lore panels, views and instruments', () => {
  it('reports a disclosure as a named panel plus a boolean string', () => {
    track({ name: 'lore.panel_toggled', panel: 'activity', open: false });
    expect(lastCall().attributes).toEqual({
      'lorekit.lore.panel.name': 'activity',
      // A string for `install_command.succeeded`'s reason — a `false` has to be
      // a row, not an absence, or "nobody ever collapses it" is unanswerable.
      'lorekit.lore.panel.open': 'false',
    });
  });

  it('says which panel swapped its body', () => {
    track({ name: 'lore.view_changed', panel: 'activity', view: 'heatmap' });
    expect(lastCall().attributes).toEqual({
      'lorekit.lore.view.panel': 'activity',
      'lorekit.lore.view.name': 'heatmap',
    });
  });

  it('records a matrix axis by its DIMENSION, never a cell value', () => {
    track({ name: 'lore.instrument_used', instrument: 'matrix', action: 'row-axis', field: 'host' });
    expect(lastCall().attributes).toEqual({
      'lorekit.lore.instrument.name': 'matrix',
      'lorekit.lore.instrument.action': 'row-axis',
      'lorekit.lore.instrument.field': 'host',
    });
  });

  it('omits the field for a gesture that has no axis', () => {
    track({ name: 'lore.instrument_used', instrument: 'timeline', action: 'select-range' });
    expect(lastCall().attributes['lorekit.lore.instrument.field']).toBeUndefined();
  });
});

describe('track — lore.cluster_selected', () => {
  it('sends a bucketed size, never the raw member count', () => {
    track({ name: 'lore.cluster_selected', action: 'select', sizeBucket: '6-10' });
    expect(lastCall().attributes).toEqual({
      'lorekit.lore.cluster.action': 'select',
      'lorekit.lore.cluster.size_bucket': '6-10',
    });
  });

  it('omits the bucket on a clear, which has no cluster', () => {
    track({ name: 'lore.cluster_selected', action: 'clear' });
    expect(lastCall().attributes).toEqual({ 'lorekit.lore.cluster.action': 'clear' });
  });
});

// ── Insights ────────────────────────────────────────────────────────────────

describe('track — insights events', () => {
  it('names which of the page TWO windows moved', () => {
    track({
      name: 'insights.range_changed',
      section: 'scope-consumption',
      preset: '30d',
      spanDays: 30,
    });
    expect(lastCall().attributes).toEqual({
      'lorekit.insights.range.section': 'scope-consumption',
      'lorekit.insights.range.preset': '30d',
      'lorekit.insights.range.span_days': 30,
    });
  });

  it('tells a quadrant DEselect apart from a select', () => {
    track({ name: 'insights.utility_quadrant_selected', quadrant: 'noise-tax', selected: false });
    expect(lastCall().attributes).toEqual({
      'lorekit.insights.utility.quadrant': 'noise-tax',
      'lorekit.insights.utility.selected': 'false',
    });
  });

  it('records a DENIED clipboard rather than counting only successes', () => {
    track({
      name: 'insights.utility_prompt_copied',
      quadrant: 'dormant',
      entryCount: 12,
      succeeded: false,
    });
    expect(lastCall().attributes).toEqual({
      'lorekit.insights.utility.quadrant': 'dormant',
      'lorekit.insights.utility.entry_count': 12,
      'lorekit.insights.utility.succeeded': 'false',
    });
  });

  it('records a hand-off to the Explorer by scope TYPE and source', () => {
    track({ name: 'insights.scope_opened', scopeType: 'repo', source: 'scope-consumption' });
    expect(lastCall().attributes).toEqual({
      'lorekit.insights.scope.type': 'repo',
      'lorekit.insights.scope.source': 'scope-consumption',
    });
  });
});
