'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Cloud, HardDrive } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Where a memory lives: the on-disk offline store or the hosted remote store. */
type MemoryStore = 'local' | 'remote';

type MemoryCard = {
  id: string;
  key: string;
  value: string;
  source?: string;
  /** which store this memory persists in — surfaced as an icon on the card */
  store: MemoryStore;
};

type LiveCard = MemoryCard & {
  /** true once act-2 memory.list has fired and this card has been "lit up" */
  loaded: boolean;
};

type ScriptLine = {
  text: string;
  type:
    | 'command'
    | 'success'
    | 'info'
    | 'agent'
    | 'error'
    | 'separator'
    | 'session-end'
    | 'session-start';
  /** ms to wait after this line before the next one begins */
  pauseAfter?: number;
  /** memory card to add to the store after this line */
  card?: MemoryCard;
};

type UseCase = {
  label: string;
  act1: ScriptLine[];
  act2: ScriptLine[];
};

// ─── Use cases ────────────────────────────────────────────────────────────────

const USE_CASES: UseCase[] = [
  {
    label: 'Self-healing',
    act1: [
      { type: 'command', text: 'pnpm build', pauseAfter: 240 },
      {
        type: 'error',
        text: '✗ ReferenceError: window is not defined  (server component)',
        pauseAfter: 320,
      },
      {
        type: 'agent',
        text: '> Agent: Guarded window access with a typeof check.\n         Recording the fix so I never trip on this again.',
        pauseAfter: 260,
      },
      {
        type: 'command',
        text: 'memory.write { scope: "repo::lorekit", key: "fix/ssr-window", value: "guard window with typeof check in server components" }',
        pauseAfter: 60,
        card: {
          id: 'ssr',
          key: 'fix/ssr-window',
          value: 'guard window with typeof check in server components',
          store: 'remote',
        },
      },
      { type: 'success', text: '✓ Saved', pauseAfter: 500 },
      {
        type: 'error',
        text: '✗ Hydration mismatch: server/client <time> differ',
        pauseAfter: 320,
      },
      {
        type: 'agent',
        text: '> Agent: Rendered the date client-side only.\n         Saving so it never recurs.',
        pauseAfter: 260,
      },
      {
        type: 'command',
        text: 'memory.write { scope: "repo::lorekit", key: "fix/hydration-date", value: "render dates client-side only to avoid hydration mismatch" }',
        pauseAfter: 60,
        card: {
          id: 'hydration',
          key: 'fix/hydration-date',
          value: 'render dates client-side only to avoid hydration mismatch',
          store: 'local',
        },
      },
      { type: 'success', text: '✓ Saved', pauseAfter: 800 },
    ],
    act2: [
      { type: 'separator', text: '— New session —', pauseAfter: 320 },
      { type: 'command', text: 'memory.list { scope: "repo::lorekit" }', pauseAfter: 60 },
      { type: 'info', text: '  ↳ 2 memories loaded', pauseAfter: 400 },
      {
        type: 'agent',
        text: '> Agent: Known pitfalls here: SSR window access + date hydration.\n         Writing it right the first time.',
        pauseAfter: 300,
      },
      { type: 'success', text: '✓ Past mistakes avoided automatically', pauseAfter: 2000 },
    ],
  },
  {
    label: 'Code conventions',
    act1: [
      {
        type: 'command',
        text: 'memory.write { scope: "repo::lorekit", key: "style/indent", value: "2 spaces" }',
        pauseAfter: 60,
        card: { id: 'indent', key: 'style/indent', value: '2 spaces', store: 'local' },
      },
      { type: 'success', text: '✓ Saved', pauseAfter: 320 },
      {
        type: 'command',
        text: 'memory.write { scope: "repo::lorekit", key: "style/exports", value: "no default exports" }',
        pauseAfter: 60,
        card: { id: 'exports', key: 'style/exports', value: 'no default exports', store: 'local' },
      },
      { type: 'success', text: '✓ Saved', pauseAfter: 320 },
      {
        type: 'command',
        text: 'memory.write { scope: "repo::lorekit", key: "db/columns", value: "snake_case" }',
        pauseAfter: 60,
        card: { id: 'db', key: 'db/columns', value: 'snake_case', store: 'remote' },
      },
      { type: 'success', text: '✓ Saved', pauseAfter: 800 },
    ],
    act2: [
      { type: 'separator', text: '— New session —', pauseAfter: 320 },
      { type: 'command', text: 'memory.list { scope: "repo::lorekit" }', pauseAfter: 60 },
      { type: 'info', text: '  ↳ 3 memories loaded', pauseAfter: 400 },
      {
        type: 'agent',
        text: '> Agent: I see snake_case for DB columns and 2-space indentation.\n         Continuing with those conventions.',
        pauseAfter: 300,
      },
      { type: 'success', text: '✓ No context re-establishment needed', pauseAfter: 2000 },
    ],
  },
  {
    label: 'PR review',
    act1: [
      {
        type: 'command',
        text: 'memory.write { scope: "repo::lorekit", key: "review/logging", value: "use custom logger, not console.log" }',
        pauseAfter: 60,
        card: {
          id: 'logging',
          key: 'review/logging',
          value: 'use custom logger, not console.log',
          source: 'PR #42',
          store: 'remote',
        },
      },
      { type: 'success', text: '✓ Saved  (source: PR #42 review comment)', pauseAfter: 320 },
      {
        type: 'command',
        text: 'memory.write { scope: "repo::lorekit", key: "review/components", value: "prefer server components" }',
        pauseAfter: 60,
        card: {
          id: 'components',
          key: 'review/components',
          value: 'prefer server components',
          source: 'PR #38',
          store: 'remote',
        },
      },
      { type: 'success', text: '✓ Saved  (source: PR #38 review comment)', pauseAfter: 800 },
    ],
    act2: [
      { type: 'separator', text: '— New session —', pauseAfter: 320 },
      { type: 'command', text: 'memory.list { scope: "repo::lorekit" }', pauseAfter: 60 },
      { type: 'info', text: '  ↳ 2 memories loaded', pauseAfter: 400 },
      {
        type: 'agent',
        text: '> Agent: From past reviews: use custom logger,\n         prefer server components. Applying now.',
        pauseAfter: 300,
      },
      { type: 'success', text: '✓ Review context retained automatically', pauseAfter: 2000 },
    ],
  },
];

const CHAR_DELAY = 16;
const LINE_GAP = 320;
const CARD_APPEAR_DELAY = 180;
const LOAD_STAGGER = 130; // ms between each card lighting up

/** Both terminal panes share one fixed height so the window never resizes and
 *  the two panes stay balanced. Keep them in lockstep via this single constant. */
const PANE_HEIGHT = 'h-[200px]';

// ─── TypewriterLine ───────────────────────────────────────────────────────────

function TypewriterLine({
  text,
  type,
  reducedMotion,
}: {
  text: string;
  type: ScriptLine['type'];
  reducedMotion: boolean;
}) {
  const [visible, setVisible] = useState(reducedMotion ? text.length : 0);

  useEffect(() => {
    if (reducedMotion) { setVisible(text.length); return; }
    setVisible(0);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setVisible(i);
      if (i >= text.length) clearInterval(id);
    }, CHAR_DELAY);
    return () => clearInterval(id);
  }, [text, reducedMotion]);

  const LINE_COLOR: Record<ScriptLine['type'], string> = {
    command:       'text-[var(--color-content-primary)]',
    success:       'text-[var(--color-success)]',
    info:          'text-[var(--color-scope-repo)]',
    agent:         'text-[var(--color-accent)]',
    error:         'text-[var(--color-error)]',
    separator:     'text-[var(--color-content-tertiary)]',
    'session-end': 'text-[var(--color-error)]',
    'session-start': 'text-[var(--color-success)]',
  };
  const colorClass = LINE_COLOR[type] ?? 'text-[var(--color-content-secondary)]';

  return (
    <div className={`font-mono text-xs leading-relaxed whitespace-pre-wrap ${colorClass}`}>
      {text.slice(0, visible)}
      {visible < text.length && !reducedMotion && (
        <span className="inline-block w-[1ch] animate-pulse bg-current opacity-70">▋</span>
      )}
    </div>
  );
}

// ─── MemoryCard ───────────────────────────────────────────────────────────────

/**
 * A persisted memory card. Stays visible throughout both acts.
 *
 * Visual transition when `loaded` flips true:
 *   - Card border and background CSS-transition to amber (via class swap +
 *     `transition-colors` — no layout-triggering properties animated).
 *   - The badge label swaps text and scales in via Motion opacity+transform.
 *   - The value text transitions to amber via `transition-colors`.
 */
function MemoryCard({ card }: { card: LiveCard }) {
  const { loaded } = card;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0, 0, 0.2, 1] }}
      className={[
        'rounded-lg border px-3 py-2 font-mono text-xs',
        'transition-colors duration-500',
        loaded
          ? 'border-[var(--color-accent)]/50 bg-[var(--color-accent-subtle)]'
          : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)]',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 mb-1">
        {/* Badge — remounts on state change so it animates in */}
        <motion.span
          key={loaded ? 'loaded' : 'written'}
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.22, ease: [0, 0, 0.2, 1] }}
          className={[
            'text-[10px] font-semibold uppercase tracking-wide',
            loaded
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-content-tertiary)]',
          ].join(' ')}
        >
          {loaded ? '↳ loaded' : '✓ written'}
        </motion.span>

        {card.source && (
          <span className="text-[10px] text-[var(--color-content-tertiary)]">
            · {card.source}
          </span>
        )}

        {/* Store indicator — makes it explicit whether this memory is kept in
            the on-disk offline store or the hosted remote store. */}
        <span
          className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--color-content-tertiary)]"
          title={card.store === 'remote' ? 'Hosted remote store' : 'On-disk local store'}
        >
          {card.store === 'remote'
            ? <Cloud className="size-3" aria-hidden />
            : <HardDrive className="size-3" aria-hidden />}
          {card.store}
        </span>
      </div>

      <div>
        <span className="text-[var(--color-content-secondary)]">{card.key}</span>
        {' · '}
        <span
          className={[
            'transition-colors duration-500',
            loaded ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-primary)]',
          ].join(' ')}
        >
          {card.value}
        </span>
      </div>
    </motion.div>
  );
}

// ─── TerminalTheater ──────────────────────────────────────────────────────────

export function TerminalTheater() {
  const reducedMotion = useReducedMotion() ?? false;

  const [activeTab, setActiveTab] = useState(0);
  const [renderedLines, setRenderedLines] = useState<ScriptLine[]>([]);

  /**
   * The terminal-output pane has a fixed height (so the window never resizes),
   * which means a tall script — e.g. the Self-healing act — would otherwise
   * stream its final, payoff lines below the fold. Keep the newest line in view
   * by pinning the scroll to the bottom whenever a line is added.
   */
  const outputRef = useRef<HTMLDivElement>(null);

  /**
   * Single card array. Cards are added (loaded: false) during act 1 and
   * NEVER removed — the memory store persists across the session boundary.
   * `loaded` flips to true per-card (staggered) when act 2's memory.list fires.
   */
  const [cards, setCards] = useState<LiveCard[]>([]);

  /** 'a' = session A writing | 'b' = session B with memories active */
  const [act, setAct] = useState<'a' | 'b'>('a');

  const cancelRef = useRef(false);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearTimers() {
    cancelRef.current = true;
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Always resolve so the promise settles; callers check cancelRef after each await
      const id = setTimeout(resolve, ms);
      timeoutsRef.current.push(id);
    });
  }

  const play = useCallback(
    async (tabIndex: number) => {
      clearTimers();
      cancelRef.current = false;

      const useCase = USE_CASES[tabIndex];
      if (!useCase) return;

      // ── Hard reset ────────────────────────────────────────────────────────
      setRenderedLines([]);
      setCards([]);
      setAct('a');

      if (reducedMotion) {
        // Instant: show all lines + all cards already loaded
        setRenderedLines([...useCase.act1, ...useCase.act2]);
        const allCards: LiveCard[] = useCase.act1
          .flatMap((l) => (l.card ? [l.card] : []))
          .map((c) => ({ ...c, loaded: true }));
        setCards(allCards);
        setAct('b');
        return;
      }

      // ── Act 1: write memories ─────────────────────────────────────────────
      for (const line of useCase.act1) {
        if (cancelRef.current) return;
        setRenderedLines((prev) => [...prev, line]);
        await wait(line.text.length * CHAR_DELAY + 80);

        if (line.card) {
          const card = line.card;
          await wait(CARD_APPEAR_DELAY);
          if (cancelRef.current) return;
          // Append card in `written` state — it stays from here on
          setCards((prev) => [...prev, { ...card, loaded: false }]);
        }

        await wait(line.pauseAfter ?? LINE_GAP);
      }

      // ── Session boundary — cards stay visible ─────────────────────────────
      if (cancelRef.current) return;
      await wait(400);
      setRenderedLines((prev) => [
        ...prev,
        { type: 'session-end', text: '[Session ended]' },
      ]);
      await wait(900);

      // Clear terminal lines only — memory store untouched
      if (cancelRef.current) return;
      setRenderedLines([]);
      await wait(200);

      // ── Act 2: load memories ──────────────────────────────────────────────
      setAct('b');

      for (const line of useCase.act2) {
        if (cancelRef.current) return;
        setRenderedLines((prev) => [...prev, line]);
        await wait(line.text.length * CHAR_DELAY + 80);

        // Stagger light-up one card at a time as each memory "loads"
        if (line.type === 'info' && line.text.includes('memories loaded')) {
          const cardCount = useCase.act1.filter((l) => l.card).length;
          for (let i = 0; i < cardCount; i++) {
            const cardIndex = i;
            const delay = cardIndex * LOAD_STAGGER;
            const id = setTimeout(() => {
              if (!cancelRef.current) setCards((prev) => prev.map((card, j) => (j === cardIndex ? { ...card, loaded: true } : card)));
            }, delay);
            timeoutsRef.current.push(id);
          }
          // Wait for all stagger timeouts before next line
          await wait(cardCount * LOAD_STAGGER + 200);
        }

        await wait(line.pauseAfter ?? LINE_GAP);
      }

      // ── Loop: dim cards back to written, then restart ─────────────────────
      if (cancelRef.current) return;
      await wait(400);
      setCards((prev) => prev.map((card) => ({ ...card, loaded: false })));
      setAct('a');
      await wait(300);

      if (!cancelRef.current) play(tabIndex);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reducedMotion],
  );

  useEffect(() => {
    play(activeTab);
    return () => clearTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Keep the latest streamed line visible within the fixed-height output pane.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [renderedLines]);

  const anyLoaded = act === 'b';

  return (
    <section
      aria-label="Terminal demo: how LoreKit persists agent memory"
      className="w-full max-w-2xl mx-auto"
    >
      {/* Heading */}
      <div className="mb-6 text-center">
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)] mb-1">
          Watch memories form and persist
        </h2>
        <p className="text-sm text-[var(--color-content-secondary)]">
          Session A writes. Session B loads. No re-explaining.
        </p>
      </div>

      {/* Terminal window */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] overflow-hidden shadow-[0_0_40px_var(--color-accent-glow)]">

        {/* Title bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <div className="flex items-center gap-1.5" aria-hidden>
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
          <span className="flex-1 text-center font-mono text-xs text-[var(--color-content-tertiary)]">
            LoreKit Memory — zsh
          </span>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-raised)]">
          {USE_CASES.map((uc, i) => (
            <button
              key={uc.label}
              onClick={() => { if (i !== activeTab) setActiveTab(i); }}
              className={[
                'relative px-3 py-1.5 rounded-md font-mono text-xs',
                'transition-colors duration-150',
                'focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
                activeTab === i
                  ? 'text-[var(--color-content-primary)]'
                  : 'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
              ].join(' ')}
            >
              {activeTab === i && (
                <motion.span
                  layoutId="tab-indicator"
                  className="absolute inset-0 rounded-md bg-[var(--color-bg-elevated)] border border-[var(--color-border)]"
                  transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                />
              )}
              <span className="relative z-10">{uc.label}</span>
            </button>
          ))}

          {/* Session indicator */}
          <div
            className="ml-auto flex items-center gap-1.5"
            aria-live="polite"
            aria-label={anyLoaded ? 'Session B — memories loaded' : 'Session A — writing memories'}
          >
            <span
              className={[
                'size-1.5 rounded-full transition-colors duration-500 animate-pulse',
                anyLoaded ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-success)]',
              ].join(' ')}
              aria-hidden
            />
            <span className="font-mono text-[10px] text-[var(--color-content-tertiary)]">
              {anyLoaded ? 'session B' : 'session A'}
            </span>
          </div>
        </div>

        {/* Terminal output — fixed height so the window never resizes as lines
            stream in and out (keeps the footer below it from jumping). */}
        <div
          ref={outputRef}
          className={`px-4 py-4 ${PANE_HEIGHT} overflow-y-auto space-y-1.5`}
          aria-live="polite"
          aria-label="Terminal output"
        >
          <AnimatePresence mode="popLayout">
            {renderedLines.map((line, i) => (
              <motion.div
                key={`${activeTab}-${i}-${line.text.slice(0, 16)}`}
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <TypewriterLine
                  text={line.text}
                  type={line.type}
                  reducedMotion={reducedMotion}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Memory store — cards never leave this area */}
        <div
          className={[
            'border-t border-[var(--color-border)] px-4 py-4',
            'transition-colors duration-700',
            anyLoaded
              ? 'bg-[var(--color-accent-subtle)]'
              : 'bg-[var(--color-bg-raised)]',
          ].join(' ')}
        >
          <div className="mb-3 flex items-center justify-between">
            <p className="font-mono text-[10px] text-[var(--color-content-tertiary)] uppercase tracking-widest">
              memory store
            </p>
            {/* Legend for the per-card store icons */}
            <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-wide text-[var(--color-content-tertiary)]">
              <span className="inline-flex items-center gap-1">
                <HardDrive className="size-3" aria-hidden /> local
              </span>
              <span className="inline-flex items-center gap-1">
                <Cloud className="size-3" aria-hidden /> remote
              </span>
            </div>
          </div>
          {/* Fixed height so the card list never changes the window height as
              memories are written one by one. */}
          <div className={`flex flex-col gap-2 ${PANE_HEIGHT} overflow-y-auto pr-1`}>
            <AnimatePresence mode="popLayout">
              {cards.map((card) => (
                <MemoryCard key={`${activeTab}-${card.id}`} card={card} />
              ))}
            </AnimatePresence>
            {cards.length === 0 && (
              <p className="font-mono text-xs text-[var(--color-content-tertiary)] italic">
                — none yet —
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Caption */}
      <p className="mt-4 text-center font-mono text-xs text-[var(--color-content-tertiary)]">
        Memories survive session ends · Shared across Claude Code, Cursor &amp; Codex
      </p>
    </section>
  );
}
