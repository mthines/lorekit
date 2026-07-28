'use client';

/**
 * CommandPaletteProvider
 *
 * Global context that powers the cmd+k palette:
 * - Maintains a registry of `Command` objects added by any component/page.
 * - Manages open/close state and the nested navigation stack (PaletteFrame[]).
 * - Runs the global keyboard listener for `mod+k` (open) and for chained
 *   shortcuts registered on commands.
 *
 * ## Nested navigation (Linear-style)
 * When a command has `children`, activating it pushes a new PaletteFrame onto
 * the stack. Pressing Escape or Backspace on an empty search pops back to the
 * parent level. The root frame is always `stack[0]`.
 *
 * ## Chained shortcuts (VSCode-style)
 * The chord engine accumulates pressed keys. If a partial sequence matches a
 * registered shortcut prefix, we wait up to CHORD_TIMEOUT_MS for the next key.
 * A completed chord fires the matching command's `onSelect` or opens its children.
 *
 * ## Shortcut execution context
 * Shortcuts fire even when the palette is closed, UNLESS the focused element is
 * an <input>, <textarea>, or [contenteditable]. The `mod+k` toggle always fires.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Command, PaletteFrame } from './types';
import { CHORD_TIMEOUT_MS, canonicalKey, isMac, normalizeToken } from './shortcut';
import { track, type CommandSource, type PaletteTrigger } from '@/lib/analytics/track';

// ── Context ───────────────────────────────────────────────────────────────────

interface CommandPaletteContextValue {
  /** Whether the palette overlay is currently open. */
  open: boolean;
  /** The full navigation stack (root at index 0). */
  stack: PaletteFrame[];
  /** Current topmost frame. */
  currentFrame: PaletteFrame | null;
  /** Open the palette at the root level. `trigger` tags the RUM event. */
  openPalette: (trigger?: PaletteTrigger) => void;
  /** Close the palette. */
  closePalette: () => void;
  /** Navigate into a command's children (or fire onSelect). `source` tags the RUM event. */
  activateCommand: (command: Command, source?: CommandSource) => Promise<void>;
  /** Pop the current nested level (or close if at root). */
  popFrame: () => void;
  /**
   * Register a command. Returns a cleanup function that removes it.
   * Commands are de-duplicated by `id`; the last registration wins.
   */
  register: (command: Command) => () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used within <CommandPaletteProvider>');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  // Registry: commands indexed by id, in insertion order.
  const registryRef = useRef<Map<string, Command>>(new Map());
  // Force re-render when registry changes (so openPalette gets fresh commands).
  const [registryVersion, setRegistryVersion] = useState(0);

  // Palette open/close + navigation stack.
  const [open, setOpen] = useState(false);
  const [stack, setStack] = useState<PaletteFrame[]>([]);

  // Chord engine.
  const chordRef = useRef<string[]>([]);
  const chordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep latest values in refs so event listeners don't capture stale state.
  const openRef = useRef(open);
  openRef.current = open;

  const rootCommands = useCallback((): Command[] => {
    return Array.from(registryRef.current.values());
  }, [registryVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPalette = useCallback(
    (trigger: PaletteTrigger = 'button') => {
      setStack([{ parentCommand: null, commands: rootCommands(), loading: false }]);
      setOpen(true);
      track({ name: 'command_palette.opened', trigger });
    },
    [rootCommands],
  );

  const closePalette = useCallback(() => {
    setOpen(false);
    setStack([]);
  }, []);

  const popFrame = useCallback(() => {
    setStack((prev) => {
      if (prev.length <= 1) {
        setOpen(false);
        return [];
      }
      return prev.slice(0, -1);
    });
  }, []);

  const activateCommand = useCallback(
    async (command: Command, source: CommandSource = 'palette'): Promise<void> => {
      if (command.children) {
        if (typeof command.children === 'function') {
          // Push a loading frame immediately for perceived responsiveness.
          const loadingFrame: PaletteFrame = {
            parentCommand: command,
            commands: [],
            loading: true,
          };
          setStack((prev) => [...prev, loadingFrame]);
          try {
            const kids = await command.children();
            // Replace the loading frame with the resolved one.
            setStack((prev) => [
              ...prev.slice(0, -1),
              { parentCommand: command, commands: kids, loading: false },
            ]);
          } catch {
            // On error, pop the loading frame.
            setStack((prev) => prev.slice(0, -1));
          }
        } else {
          // Static children — push immediately.
          setStack((prev) => [
            ...prev,
            { parentCommand: command, commands: command.children as Command[], loading: false },
          ]);
        }
        return;
      }
      if (command.onSelect) {
        closePalette();
        // Track leaf executions only — drilling into a submenu (the `children`
        // branch above) returns early and is intentionally not counted.
        track({
          name: 'command_palette.command_selected',
          commandId: command.id,
          group: command.group,
          source,
        });
        await command.onSelect();
      }
    },
    [closePalette],
  );

  // ── Chord / shortcut engine ───────────────────────────────────────────────

  const clearChord = useCallback(() => {
    chordRef.current = [];
    if (chordTimerRef.current) {
      clearTimeout(chordTimerRef.current);
      chordTimerRef.current = null;
    }
  }, []);

  const fireChord = useCallback(
    (sequence: string[]): boolean => {
      for (const command of registryRef.current.values()) {
        if (!command.shortcut) continue;
        const { keys } = command.shortcut;
        if (keys.length !== sequence.length) continue;
        const match = keys.every((token, i) => normalizeToken(token) === sequence[i]);
        if (match) {
          if (command.children || command.onSelect) {
            activateCommand(command, 'shortcut');
          }
          return true;
        }
      }
      return false;
    },
    [activateCommand],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const modPressed = isMac() ? e.metaKey : e.ctrlKey;

      // mod+k — toggle palette.
      if (e.key === 'k' && modPressed && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (openRef.current) {
          closePalette();
        } else {
          openPalette('shortcut');
        }
        return;
      }

      // When the palette is open, handle Escape here as a safety-net for the
      // case where the search input has lost browser focus (e.g. the user
      // tabbed away, focus was moved programmatically, or a sub-frame is still
      // loading). Normally the input's own onKeyDown catches Escape; this
      // handler catches it when the input is NOT focused.
      if (openRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          // Mirror the input handler: pop nested frame or close at root.
          setStack((prev) => {
            if (prev.length <= 1) {
              setOpen(false);
              return [];
            }
            return prev.slice(0, -1);
          });
        }
        return;
      }
      const target = e.target as HTMLElement;
      const inTextField =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;
      if (inTextField) return;

      // Ignore pure modifier key events.
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      // Accumulate chord. Each step is a CANONICAL token that captures the
      // modifier state (mod/shift/alt) held during this keypress, so a modified
      // sequence like `mod+shift+m → mod+shift+o` accumulates as
      // ['mod+shift+m', 'mod+shift+o'] and matches. Plain keys (`g`, `h`)
      // canonicalise to themselves, so chained letter chords are unchanged.
      const token = canonicalKey({
        key: e.key.toLowerCase(),
        mod: modPressed,
        shift: e.shiftKey,
        alt: e.altKey,
      });
      const newChord = [...chordRef.current, token];
      chordRef.current = newChord;

      if (chordTimerRef.current) clearTimeout(chordTimerRef.current);

      // Check for a full match.
      const matched = fireChord(newChord);
      if (matched) {
        e.preventDefault();
        clearChord();
        return;
      }

      // Check if any command has the current sequence as a prefix.
      const hasPrefix = Array.from(registryRef.current.values()).some((cmd) => {
        if (!cmd.shortcut) return false;
        const { keys } = cmd.shortcut;
        return (
          keys.length > newChord.length &&
          newChord.every((k, i) => k === normalizeToken(keys[i]!))
        );
      });

      if (hasPrefix) {
        e.preventDefault();
        chordTimerRef.current = setTimeout(clearChord, CHORD_TIMEOUT_MS);
      } else {
        clearChord();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openPalette, closePalette, fireChord, clearChord]);

  // ── Register / deregister ─────────────────────────────────────────────────

  const register = useCallback((command: Command): (() => void) => {
    registryRef.current.set(command.id, command);
    setRegistryVersion((v) => v + 1);
    return () => {
      registryRef.current.delete(command.id);
      setRegistryVersion((v) => v + 1);
    };
  }, []);

  const currentFrame = stack[stack.length - 1] ?? null;

  const value = useMemo<CommandPaletteContextValue>(
    () => ({
      open,
      stack,
      currentFrame,
      openPalette,
      closePalette,
      activateCommand,
      popFrame,
      register,
    }),
    [open, stack, currentFrame, openPalette, closePalette, activateCommand, popFrame, register],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
    </CommandPaletteContext.Provider>
  );
}
