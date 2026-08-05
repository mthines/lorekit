'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Cloud, HardDrive } from 'lucide-react';

import { useAmbientAnimation } from '@/lib/hooks/useAmbientAnimation';
import { createPausableTimers, type PausableTimers } from '@/lib/pausable-timers';

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

// ─── TypewriterLine ───────────────────────────────────────────────────────────

function TypewriterLine({
  text,
  type,
  reducedMotion,
  paused,
}: {
  text: string;
  type: ScriptLine['type'];
  reducedMotion: boolean;
  /** Freeze mid-word, keeping the characters already typed. */
  paused: boolean;
}) {
  const [visible, setVisible] = useState(reducedMotion ? text.length : 0);

  // Start over only when the LINE changes — never when playback pauses, which
  // is the whole point: a line frozen halfway resumes from the character it
  // stopped on rather than re-typing itself.
  useEffect(() => {
    setVisible(reducedMotion ? text.length : 0);
  }, [text, reducedMotion]);

  const complete = visible >= text.length;

  useEffect(() => {
    if (reducedMotion || paused || complete) return undefined;
    // `complete` (not `visible`) is the dependency, so the interval is created
    // once per line and torn down once — not re-subscribed on every character.
    const id = setInterval(() => setVisible((typed) => typed + 1), CHAR_DELAY);
    return () => clearInterval(id);
  }, [text, reducedMotion, paused, complete]);

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

  // The line occupies its FINAL size from the very first frame.
  //
  // Rendering only `text.slice(0, visible)` re-measures the box on every one of
  // the ~60 ticks a second this component runs at: a line long enough to wrap
  // grows a row mid-type, which pushes every sibling below it down and books a
  // layout shift. With the loop restarting forever, the login page accumulated
  // thousands of CLS entries per visit (p75 0.21, worst 0.58).
  //
  // The theater does NOT sit above the sign-in CTA: `(auth)/login/page.tsx`
  // renders the primary `LoginButton` at L155 and `<TerminalTheater />` at
  // L165, so the shifting text is below it — only the header's compact sign-in
  // button (L111) is above. The cost is the accrued shift entries themselves,
  // which CLS sums for the whole session; it is not a CTA moving under a cursor.
  //
  // So: a full, invisible copy of the text reserves the space, and the typed
  // prefix is painted over it. The overlay is out of flow, so the number of
  // characters showing can no longer affect layout at all — the animation is
  // unchanged, it just stops moving the page.
  return (
    <div className={`relative font-mono text-xs leading-relaxed whitespace-pre-wrap ${colorClass}`}>
      <span aria-hidden className="invisible">
        {text}
      </span>
      <span className="absolute inset-0">
        {text.slice(0, visible)}
        {visible < text.length && !reducedMotion && (
          <span className="inline-block w-[1ch] animate-pulse bg-current opacity-70">▋</span>
        )}
      </span>
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

  /**
   * Only run while the theater is on screen in the foreground tab.
   *
   * The script loops forever, so an ungated instance keeps typing — one React
   * re-render per character, ~60 a second — for the whole visit, including
   * while it is scrolled past or the tab is in the background. That is pure
   * main-thread contention with whatever the visitor does next, which is what
   * an INP measurement is queued behind (worst observed on this page: 3.0s).
   */
  const [theaterRef, animationActive] = useAmbientAnimation();

  const cancelRef = useRef(false);

  /**
   * Every wait in the script runs through one pausable group, so going off
   * screen FREEZES the script rather than cancelling it: a 320ms beat that was
   * 200ms from finishing resumes as a 200ms beat, and the visitor comes back to
   * the sentence they left rather than to the top of the demo.
   *
   * Created lazily and kept in a ref so a re-render never swaps the group the
   * in-flight `play()` loop is awaiting on.
   */
  const timersRef = useRef<PausableTimers | null>(null);
  function timers(): PausableTimers {
    timersRef.current ??= createPausableTimers();
    return timersRef.current;
  }

  function clearTimers() {
    cancelRef.current = true;
    timers().cancel();
  }

  function wait(ms: number): Promise<void> {
    // Always settles — including on cancel — so the awaiting loop reaches its
    // next `cancelRef` check and unwinds instead of hanging.
    return timers().wait(ms);
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
            // Through the pausable group, like every other beat — a raw
            // setTimeout here would keep firing while the theater is off
            // screen and light the cards up out of step with the script.
            void wait(cardIndex * LOAD_STAGGER).then(() => {
              if (!cancelRef.current) setCards((prev) => prev.map((card, j) => (j === cardIndex ? { ...card, loaded: true } : card)));
            });
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

  // Playback is started by the ACTIVE TAB alone. Visibility must not appear
  // here: re-running this effect calls `play()`, which hard-resets the script,
  // and scrolling past a demo is not a request to start it over.
  useEffect(() => {
    play(activeTab);
    return () => clearTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Visibility only suspends and resumes the clock the script is awaiting on,
  // so the loop stays exactly where it was.
  useEffect(() => {
    if (animationActive) timers().resume();
    else timers().pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationActive]);

  // Keep the latest streamed line visible within the fixed-height output pane.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [renderedLines]);

  const anyLoaded = act === 'b';

  return (
    <section
      ref={theaterRef}
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
          className="px-4 py-4 h-[200px] overflow-y-auto space-y-1.5"
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
                  paused={!animationActive}
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
          <div className="flex flex-col gap-2 h-[200px] overflow-y-auto pr-1">
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
