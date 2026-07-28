'use client';

/**
 * CommandPalette
 *
 * The visual overlay rendered when `open=true`. Features:
 * - Fuzzy search / filter across the current frame's commands.
 * - Grouped items with separator labels.
 * - Icons, shortcut badge, and a loading spinner.
 * - Keyboard navigation: Arrow keys, Enter to activate, Escape/Backspace to pop.
 * - Nested breadcrumb showing the parent command label when drilling.
 * - `mod+k` always closes (handled in the provider; Escape also closes).
 *
 * Rendered once at the dashboard layout root (inside `CommandPaletteProvider`),
 * so it overlays every page.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
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
      className="flex shrink-0 items-center gap-0.5 text-[10px] font-mono text-[var(--color-content-tertiary)]"
      aria-label={`Shortcut: ${formatShortcut(keys)}`}
    >
      {keys.map((k, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-0.5 opacity-40">then</span>}
          <kbd className="inline-flex h-4.5 min-w-5 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1">
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

function CommandRow({ command, selected, onActivate, onHover }: CommandRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);

  // Scroll into view when selected.
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
      onMouseEnter={onHover}
      onClick={onActivate}
      className={[
        'flex w-full min-h-10 items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors',
        selected
          ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
          : 'text-[var(--color-content-primary)] hover:bg-[var(--color-bg-elevated)]',
      ].join(' ')}
    >
      {/* Icon */}
      {command.icon && (
        <span
          className={[
            'flex size-4 shrink-0 items-center justify-center',
            selected ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-secondary)]',
          ].join(' ')}
          aria-hidden
        >
          {command.icon}
        </span>
      )}

      {/* Label + description */}
      <span className="flex-1 min-w-0">
        <span className="block truncate font-medium">{command.label}</span>
        {command.description && (
          <span className="block truncate text-xs text-[var(--color-content-tertiary)]">
            {command.description}
          </span>
        )}
      </span>

      {/* Shortcut badge */}
      {command.shortcut && (
        <ShortcutBadge keys={command.shortcut.label ? [command.shortcut.label] : command.shortcut.keys} />
      )}

      {/* Chevron for commands with children */}
      {command.children && (
        <ChevronRight
          className={[
            'size-3.5 shrink-0',
            selected ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-tertiary)]',
          ].join(' ')}
          aria-hidden
        />
      )}
    </button>
  );
}

// ── Main palette component ────────────────────────────────────────────────────

export function CommandPalette() {
  const { open, currentFrame, stack, closePalette, activateCommand, popFrame } =
    useCommandPalette();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state when palette opens / frame changes.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Focus the search input.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, currentFrame]);

  // Filtered commands for the current frame.
  const filtered = useMemo(() => {
    if (!currentFrame) return [];
    return currentFrame.commands.filter((c) => matchesSearch(c, query));
  }, [currentFrame, query]);

  const grouped = useMemo(() => groupCommands(filtered), [filtered]);

  // Flat list for keyboard navigation.
  const flat = useMemo(() => filtered, [filtered]);

  const selectedCommand = flat[selectedIndex] ?? null;

  // Clamp index when filtered list shrinks.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  // ── Keyboard navigation ─────────────────────────────────────────────────────

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % Math.max(1, flat.length));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + flat.length) % Math.max(1, flat.length));
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
        // Pop on backspace when search is empty.
        if (!query && stack.length > 1) {
          e.preventDefault();
          popFrame();
        }
        break;
      default:
        break;
    }
  }

  if (!open) return null;

  const breadcrumbs = stack
    .slice(0, -1)
    .map((f) => f.parentCommand?.label)
    .filter(Boolean) as string[];

  const isNested = stack.length > 1;
  const frameTitle = currentFrame?.parentCommand?.label ?? 'Command Palette';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        aria-hidden
        onClick={closePalette}
      />

      {/* Palette panel */}
      <div
        role="dialog"
        aria-modal
        aria-label="Command Palette"
        className="fixed inset-x-4 top-[15%] z-50 mx-auto max-w-xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-2xl shadow-black/50"
        onKeyDown={onKeyDown}
      >
        {/* Header: breadcrumb + search */}
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
          {/* Back button when nested */}
          {isNested && (
            <button
              type="button"
              onClick={popFrame}
              className="flex shrink-0 items-center justify-center rounded-md p-1 text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)] transition-colors"
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
            <Search className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
          )}

          {/* Search input */}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            placeholder={isNested ? `Search ${frameTitle}…` : 'Type a command or search…'}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            className="flex-1 bg-transparent text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] outline-none"
          />

          {/* Keyboard hint */}
          <kbd className="shrink-0 text-[10px] font-mono text-[var(--color-content-tertiary)] border border-[var(--color-border)] rounded px-1 py-0.5">
            esc
          </kbd>
        </div>

        {/* Command list */}
        <div
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label={frameTitle}
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {currentFrame?.loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-content-tertiary)]">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading…
            </div>
          ) : flat.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--color-content-tertiary)]">
              {query ? `No results for "${query}"` : 'No commands available'}
            </div>
          ) : (
            grouped.map((group, gi) => (
              <div key={gi} role="group" aria-labelledby={group.group ? `group-${gi}` : undefined}>
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
                  const flatIdx = flat.indexOf(command);
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
        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-3 py-1.5 text-[10px] text-[var(--color-content-tertiary)]">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1">↵</kbd>
              select
            </span>
            {isNested && (
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1">⌫</kbd>
                back
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1">⌘K</kbd>
            toggle
          </span>
        </div>
      </div>
    </>
  );
}
