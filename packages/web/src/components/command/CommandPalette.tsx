'use client';

/**
 * CommandPalette
 *
 * The visual overlay rendered when `open=true`. Features:
 * - Search / filter across the current frame's commands.
 * - Grouped items with separator labels.
 * - Icons, shortcut badge, and a loading spinner.
 * - Keyboard navigation: Arrow keys move selection; any printable key is
 *   forwarded to the search input so typing always filters, even after
 *   navigating with arrows (Linear-style).
 * - Nested breadcrumb showing the parent command label when drilling.
 * - Escape / Backspace (on empty search) pops back or closes.
 *
 * Rendered once at the dashboard layout root (inside `CommandPaletteProvider`),
 * so it overlays every page.
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Loader2, ArrowLeft, Search } from 'lucide-react';
import { useCommandPalette } from './CommandPaletteProvider';
import { formatShortcut } from './shortcut';
import type { Command } from './types';

// ── Search / filter ───────────────────────────────────────────────────────────

function matchesSearch(command: Command, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    command.label.toLowerCase().includes(q) ||
    (command.description?.toLowerCase().includes(q) ?? false) ||
    (command.group?.toLowerCase().includes(q) ?? false)
  );
}

// ── Grouped rendering ─────────────────────────────────────────────────────────

interface GroupedItems {
  group: string | null;
  commands: Command[];
}

function groupCommands(commands: Command[]): GroupedItems[] {
  const groups: GroupedItems[] = [];
  const seen = new Map<string, GroupedItems>();

  for (const command of commands) {
    const key = command.group ?? '';
    let group = seen.get(key);
    if (!group) {
      group = { group: command.group ?? null, commands: [] };
      groups.push(group);
      seen.set(key, group);
    }
    group.commands.push(command);
  }

  return groups;
}

// ── Shortcut badge ────────────────────────────────────────────────────────────

function ShortcutBadge({ keys }: { keys: string[] }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-content-tertiary)]"
      aria-label={`Shortcut: ${formatShortcut(keys)}`}
    >
      {keys.map((k, i) => (
        <span key={i} className="flex items-center gap-1">
          {/* "then" in the chord — kept dim and lowercase, Linear-style. */}
          {i > 0 && <span className="text-[var(--color-content-tertiary)]">then</span>}
          {/* Soft key cap: subtle fill + hairline (border-subtle, not the harder
              border), sans font, muted-but-legible text — a quiet hint, not a
              boxed button. */}
          <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-1.5 leading-none text-[var(--color-content-secondary)]">
            {formatShortcut([k])}
          </kbd>
        </span>
      ))}
    </span>
  );
}

// ── Command row ───────────────────────────────────────────────────────────────

interface CommandRowProps {
  command: Command;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
}

function CommandRow({
  command,
  selected,
  onActivate,
  onHover,
}: CommandRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);

  // Scroll selected row into view without moving browser focus away from the
  // search input — we use scrollIntoView on the element reference directly.
  useEffect(() => {
    if (selected && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  return (
    <button
      ref={rowRef}
      type="button"
      role="option"
      aria-selected={selected}
      // Never receive browser focus — keyboard focus stays on the input at all
      // times so typing immediately filters. Selection is purely visual.
      tabIndex={-1}
      onMouseEnter={onHover}
      onClick={onActivate}
      className={[
        'flex w-full min-h-10 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus:outline-none',
        selected
          ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
          : 'text-[var(--color-content-primary)] hover:bg-[var(--color-bg-elevated)]',
      ].join(' ')}
    >
      {/* Icon — vertically centered in the single-line row */}
      {command.icon && (
        <span
          className={[
            'flex size-4 shrink-0 items-center justify-center',
            selected
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-content-secondary)]',
          ].join(' ')}
          aria-hidden
        >
          {command.icon}
        </span>
      )}

      {/* Label only — single-line rows (Linear / VS Code style) so the list
          scans fast and reads calm. The description is intentionally NOT
          rendered: it stays in the SEARCH index (see `matchesSearch`) so typing
          a word from it still surfaces the command, without the per-row weight
          of a second line. */}
      <span className="min-w-0 flex-1 truncate font-normal">{command.label}</span>

      {/* Shortcut badge */}
      {command.shortcut && (
        <ShortcutBadge
          keys={
            command.shortcut.label
              ? [command.shortcut.label]
              : command.shortcut.keys
          }
        />
      )}

      {/* Chevron for commands with children */}
      {command.children && (
        <ChevronRight
          className={[
            'size-3.5 shrink-0',
            selected
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-content-tertiary)]',
          ].join(' ')}
          aria-hidden
        />
      )}
    </button>
  );
}

// ── Main palette component ────────────────────────────────────────────────────

export interface CommandPaletteProps {
  /**
   * Portal target. Defaults to `document.body` (the app case).
   *
   * Storybook passes a positioned frame element here: the visual-regression
   * hook screenshots `#storybook-root`, so an overlay portalled to `<body>`
   * would snapshot an empty root. When contained, the backdrop switches from
   * `fixed` to `absolute` so it fills the frame rather than the viewport —
   * the same contract as `BottomSheet`'s `container`.
   */
  container?: HTMLElement | null;
}

export function CommandPalette({ container }: CommandPaletteProps = {}) {
  const { open, currentFrame, stack, closePalette, activateCommand, popFrame } =
    useCommandPalette();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state and re-focus input when palette opens or the frame changes
  // (drilling into a nested level).
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, currentFrame]);

  // Filtered commands for the current frame.
  const filtered = useMemo(() => {
    if (!currentFrame) return [];
    return currentFrame.commands.filter((c) => matchesSearch(c, query));
  }, [currentFrame, query]);

  const grouped = useMemo(() => groupCommands(filtered), [filtered]);

  const selectedCommand = filtered[selectedIndex] ?? null;

  // Clamp selection index when the filtered list shrinks (e.g. as user types).
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // ── Keyboard handler on the input ───────────────────────────────────────────
  //
  // Arrow keys move the visual selection while typing focus stays on the input,
  // so any printable character the user presses immediately updates the search
  // query — identical to Linear / Raycast behaviour. The input never loses
  // focus, so there is no need to "redirect" keys.

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault(); // prevent cursor jumping to end-of-input
          setSelectedIndex((i) => (i + 1) % Math.max(1, filtered.length));
          break;
        case 'ArrowUp':
          e.preventDefault(); // prevent cursor jumping to start-of-input
          setSelectedIndex(
            (i) => (i - 1 + filtered.length) % Math.max(1, filtered.length),
          );
          break;
        case 'Enter':
          e.preventDefault();
          if (selectedCommand) activateCommand(selectedCommand);
          break;
        case 'Escape':
          e.preventDefault();
          if (stack.length > 1) {
            popFrame();
          } else {
            closePalette();
          }
          break;
        case 'Backspace':
          // Pop the nested frame only when the query is already empty — normal
          // Backspace character deletion must still work.
          if (!query && stack.length > 1) {
            e.preventDefault();
            popFrame();
          }
          break;
        default:
          break;
      }
    },
    [
      filtered.length,
      selectedCommand,
      activateCommand,
      stack.length,
      popFrame,
      closePalette,
      query,
    ],
  );

  if (!open) return null;

  const breadcrumbs = stack
    .slice(0, -1)
    .map((f) => f.parentCommand?.label)
    .filter(Boolean) as string[];

  const isNested = stack.length > 1;
  const frameTitle = currentFrame?.parentCommand?.label ?? 'Command Palette';

  return createPortal(
    // Full-screen backdrop that also flex-centers the panel. Portalled to
    // <body> so no transformed / contained ancestor can trap the fixed panel in
    // a narrow containing block (which had pinned it to the sidebar column).
    // When `container` is supplied the frame IS the viewport, so the backdrop
    // is absolute within it instead.
    <div
      className={[
        'inset-0 z-50 flex justify-center bg-black/60 p-4 backdrop-blur-sm',
        // `position` is not the only way this element reaches the viewport:
        // `15vh` measures the viewport too, so in contained mode it would track
        // the Storybook iframe rather than the frame. Contained mode centres
        // instead — container-relative by construction, and deterministic for
        // the screenshot at any iframe size.
        container ? 'absolute items-center' : 'fixed items-start pt-[15vh]',
      ].join(' ')}
      onClick={closePalette}
    >
      {/* Palette panel */}
      <div
        role="dialog"
        aria-modal
        aria-label="Command Palette"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-2xl shadow-black/50"
        // Clicks inside the panel must not bubble to the backdrop's close handler.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => {
          // Prevent the browser from moving focus away from the search input
          // when the user clicks anywhere inside the palette (rows, back button,
          // scrollbar, etc.). Without this, clicking a row steals focus to
          // <body> and subsequent Escape / arrow-key presses are silently lost.
          // The click event still fires normally — only the focus side-effect is suppressed.
          if (e.target !== inputRef.current) e.preventDefault();
        }}
      >
        {/* Header: breadcrumb + search */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          {/* Back button when nested */}
          {isNested && (
            <button
              type="button"
              onClick={popFrame}
              tabIndex={-1}
              className="flex shrink-0 items-center justify-center rounded-md p-1 text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)] transition-colors focus:outline-none"
              aria-label="Go back"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </button>
          )}

          {/* Breadcrumb trail */}
          {breadcrumbs.length > 0 && (
            <div className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-content-tertiary)]">
              {breadcrumbs.map((crumb, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3" aria-hidden />}
                  <span>{crumb}</span>
                </span>
              ))}
              <ChevronRight className="size-3" aria-hidden />
            </div>
          )}

          {/* Search icon */}
          {!isNested && (
            <Search
              className="size-4 shrink-0 text-[var(--color-content-tertiary)]"
              aria-hidden
            />
          )}

          {/* Search input — holds focus at all times; handles all keyboard nav */}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={
              selectedCommand ? `cmd-${selectedCommand.id}` : undefined
            }
            placeholder={
              isNested ? `Search ${frameTitle}…` : 'Type a command or search…'
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            // No outline — the input is permanently focused; the ring would
            // never leave and would be visually distracting.
            className="flex-1 bg-transparent text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] !outline-none !focus:outline-none"
          />

          {/* Keyboard hint — same cap recipe as the footer hints below (UI
              sans, hairline, subtle fill) so every chrome-level cap matches. */}
          <kbd className="shrink-0 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-1 text-[10px] text-[var(--color-content-tertiary)]">
            esc
          </kbd>
        </div>

        {/* Command list */}
        <div
          id="command-palette-list"
          role="listbox"
          aria-label={frameTitle}
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {currentFrame?.loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-content-tertiary)]">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--color-content-tertiary)]">
              {query ? `No results for "${query}"` : 'No commands available'}
            </div>
          ) : (
            grouped.map((group, gi) => (
              <div
                key={gi}
                role="group"
                aria-labelledby={group.group ? `group-${gi}` : undefined}
              >
                {/* Group separator */}
                {group.group && (
                  <div
                    id={`group-${gi}`}
                    className="flex items-center gap-2 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-content-tertiary)]"
                  >
                    {group.group}
                  </div>
                )}
                {group.commands.map((command) => {
                  const flatIdx = filtered.indexOf(command);
                  return (
                    <CommandRow
                      key={command.id}
                      command={command}
                      selected={flatIdx === selectedIndex}
                      onActivate={() => activateCommand(command)}
                      onHover={() => setSelectedIndex(flatIdx)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-3 py-1.5 text-[10px] text-[var(--color-content-tertiary)]">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-1">
                ↑↓
              </kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-1">
                ↵
              </kbd>
              select
            </span>
            {isNested && (
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-1">
                  ⌫
                </kbd>
                back
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-1">
              ⌘K
            </kbd>
            toggle
          </span>
        </div>
      </div>
    </div>,
    container ?? document.body,
  );
}
