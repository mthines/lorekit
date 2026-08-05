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
