'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

// ─── Types ───────────────────────────────────────────────────────────────────

type MemoryCard = {
  id: string;
  key: string;
  value: string;
  source?: string;
};

type ScriptLine = {
  text: string;
  type: 'command' | 'success' | 'info' | 'agent' | 'separator' | 'session-end' | 'session-start';
  pauseAfter?: number; // ms to wait after this line before continuing
  card?: MemoryCard;   // if set, show this memory card after the line
};

type UseCase = {
  label: string;
  act1: ScriptLine[];
  act2: ScriptLine[];
};

// ─── Use cases ───────────────────────────────────────────────────────────────

const USE_CASES: UseCase[] = [
  {
    label: 'Code conventions',
    act1: [
      { type: 'command', text: 'memory.write { scope: "repo::lorekit", key: "style/indent", value: "2 spaces" }', pauseAfter: 60, card: { id: 'indent', key: 'style/indent', value: '2 spaces' } },
      { type: 'success', text: '✓ Saved', pauseAfter: 320 },
      { type: 'command', text: 'memory.write { scope: "repo::lorekit", key: "style/exports", value: "no default exports" }', pauseAfter: 60, card: { id: 'exports', key: 'style/exports', value: 'no default exports' } },
      { type: 'success', text: '✓ Saved', pauseAfter: 320 },
      { type: 'command', text: 'memory.write { scope: "repo::lorekit", key: "db/columns", value: "snake_case" }', pauseAfter: 60, card: { id: 'db', key: 'db/columns', value: 'snake_case' } },
      { type: 'success', text: '✓ Saved', pauseAfter: 800 },
    ],
    act2: [
      { type: 'separator', text: '— New session —', pauseAfter: 320 },
      { type: 'command', text: 'memory.list { scope: "repo::lorekit" }', pauseAfter: 60 },
      { type: 'info', text: '  ↳ 3 memories loaded', pauseAfter: 400 },
      { type: 'agent', text: '> Agent: I see snake_case for DB columns and 2-space indentation.\n         Continuing with those conventions.', pauseAfter: 300 },
      { type: 'success', text: '✓ No context re-establishment needed', pauseAfter: 2000 },
    ],
  },
  {
    label: 'Auth setup',
    act1: [
      { type: 'command', text: 'memory.write { scope: "repo::lorekit", key: "auth/provider", value: "Supabase" }', pauseAfter: 60, card: { id: 'provider', key: 'auth/provider', value: 'Supabase' } },
      { type: 'success', text: '✓ Saved', pauseAfter: 320 },
      { type: 'command', text: 'memory.write { scope: "repo::lorekit", key: "auth/pattern", value: "RLS with row-level policies" }', pauseAfter: 60, card: { id: 'pattern', key: 'auth/pattern', value: 'RLS with row-level policies' } },
      { type: 'success', text: '✓ Saved', pauseAfter: 320 },
      { type: 'command', text: 'memory.write { scope: "repo::lorekit", key: "auth/sessions", value: "httpOnly cookies" }', pauseAfter: 60, card: { id: 'sessions', key: 'auth/sessions', value: 'httpOnly cookies, no JWT in localStorage' } },
      { type: 'success', text: '✓ Saved', pauseAfter: 800 },
    ],
    act2: [
      { type: 'separator', text: '— New session —', pauseAfter: 320 },
      { type: 'command', text: 'memory.list { scope: "repo::lorekit" }', pauseAfter: 60 },
      { type: 'info', text: '  ↳ 3 memories loaded', pauseAfter: 400 },
      { type: 'agent', text: '> Agent: Auth is Supabase with RLS. Using httpOnly cookies.\n         Skipping the usual setup questions.', pauseAfter: 300 },
      { type: 'success', text: '✓ No context re-establishment needed', pauseAfter: 2000 },
    ],
  },
  {
    label: 'PR review',
    act1: [
      { type: 'command', text: 'memory.write { scope: "repo::lorekit", key: "review/logging", value: "use custom logger, not console.log" }', pauseAfter: 60, card: { id: 'logging', key: 'review/logging', value: 'use custom logger, not console.log', source: 'PR #42' } },
      { type: 'success', text: '✓ Saved  (source: PR #42 review comment)', pauseAfter: 320 },
      { type: 'command', text: 'memory.write { scope: "repo::lorekit", key: "review/components", value: "prefer server components" }', pauseAfter: 60, card: { id: 'components', key: 'review/components', value: 'prefer server components', source: 'PR #38' } },
      { type: 'success', text: '✓ Saved  (source: PR #38 review comment)', pauseAfter: 800 },
    ],
    act2: [
      { type: 'separator', text: '— New session —', pauseAfter: 320 },
      { type: 'command', text: 'memory.list { scope: "repo::lorekit" }', pauseAfter: 60 },
      { type: 'info', text: '  ↳ 2 memories loaded', pauseAfter: 400 },
      { type: 'agent', text: '> Agent: From past reviews: use custom logger,\n         prefer server components. Applying now.', pauseAfter: 300 },
      { type: 'success', text: '✓ Review context retained automatically', pauseAfter: 2000 },
    ],
  },
];

const CHAR_DELAY = 28;
const LINE_GAP = 320;
const CARD_APPEAR_DELAY = 180;

// ─── Sub-components ───────────────────────────────────────────────────────────

function TypewriterLine({
  text,
  type,
  reducedMotion,
  onDone,
}: {
  text: string;
  type: ScriptLine['type'];
  reducedMotion: boolean;
  onDone: () => void;
}) {
  const [visible, setVisible] = useState(reducedMotion ? text.length : 0);
  const doneRef = useRef(false);

  useEffect(() => {
    if (reducedMotion) {
      if (!doneRef.current) { doneRef.current = true; onDone(); }
      return;
    }
    doneRef.current = false;
    setVisible(0);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setVisible(i);
      if (i >= text.length) {
        clearInterval(id);
        if (!doneRef.current) { doneRef.current = true; onDone(); }
      }
    }, CHAR_DELAY);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, reducedMotion]);

  const colorClass =
    type === 'command' ? 'text-[var(--color-content-primary)]' :
    type === 'success' ? 'text-[var(--color-success)]' :
    type === 'info'    ? 'text-[var(--color-scope-repo)]' :
    type === 'agent'   ? 'text-[var(--color-accent)]' :
    type === 'separator' ? 'text-[var(--color-content-tertiary)]' :
    type === 'session-end' ? 'text-[var(--color-error)]' :
    type === 'session-start' ? 'text-[var(--color-success)]' :
    'text-[var(--color-content-secondary)]';

  return (
    <div className={`font-mono text-xs leading-relaxed whitespace-pre-wrap ${colorClass}`}>
      {text.slice(0, visible)}
      {visible < text.length && !reducedMotion && (
        <span className="inline-block w-[1ch] animate-pulse bg-current opacity-70">▋</span>
      )}
    </div>
  );
}

function MemoryCard({ card, loaded }: { card: MemoryCard; loaded?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25, ease: [0, 0, 0.2, 1] }}
      className={`rounded-lg border px-3 py-2 font-mono text-xs ${
        loaded
          ? 'border-[var(--color-accent)]/40 bg-transparent'
          : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)]'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[10px] font-semibold uppercase tracking-wide ${loaded ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-tertiary)]'}`}>
          {loaded ? '↳ loaded' : '✓ written'}
        </span>
        {card.source && (
          <span className="text-[10px] text-[var(--color-content-tertiary)]">· {card.source}</span>
        )}
      </div>
      <div className="text-[var(--color-content-tertiary)]">
        <span className="text-[var(--color-content-secondary)]">{card.key}</span>
        {' '}·{' '}
        <span className="text-[var(--color-content-primary)]">{card.value}</span>
      </div>
    </motion.div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TerminalTheater() {
  const reducedMotion = useReducedMotion() ?? false;
  const [activeTab, setActiveTab] = useState(0);
  const [renderedLines, setRenderedLines] = useState<ScriptLine[]>([]);
  const [act1Cards, setAct1Cards] = useState<MemoryCard[]>([]);
  const [act2Cards, setAct2Cards] = useState<MemoryCard[]>([]);
  const [showAct1Cards, setShowAct1Cards] = useState(false);
  const [showAct2Cards, setShowAct2Cards] = useState(false);

  // Use a ref to hold the "play" state so we can cancel it cleanly
  const cancelRef = useRef(false);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearTimers() {
    cancelRef.current = true;
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (cancelRef.current) return;
      const id = setTimeout(resolve, ms);
      timeoutsRef.current.push(id);
    });
  }

  const play = useCallback(async (tabIndex: number) => {
    clearTimers();
    cancelRef.current = false;

    const useCase = USE_CASES[tabIndex];
    if (!useCase) return;

    // Reset state
    setRenderedLines([]);
    setAct1Cards([]);
    setAct2Cards([]);
    setShowAct1Cards(false);
    setShowAct2Cards(false);

    if (reducedMotion) {
      // Show everything immediately
      const allLines = [...useCase.act1, ...useCase.act2];
      setRenderedLines(allLines);
      const cards = allLines.flatMap((l) => l.card ? [l.card] : []);
      setAct2Cards(cards);
      setShowAct2Cards(true);
      return;
    }

    // ACT 1
    const act1Lines = useCase.act1;
    for (const line of act1Lines) {
      if (cancelRef.current) return;
      setRenderedLines((prev) => [...prev, line]);
      // Wait for typewriter to finish — approximated by char count + a small buffer
      const typeDuration = line.text.length * CHAR_DELAY + 80;
      await wait(typeDuration);
      if (line.card) {
        await wait(CARD_APPEAR_DELAY);
        if (cancelRef.current) return;
        setAct1Cards((prev) => [...prev, line.card!]);
        setShowAct1Cards(true);
      }
      await wait(line.pauseAfter ?? LINE_GAP);
    }

    // Session end
    if (cancelRef.current) return;
    await wait(400);
    setRenderedLines((prev) => [...prev, { type: 'session-end', text: '[Session ended — memory: none]' }]);
    await wait(700);

    // Cards fade out
    setShowAct1Cards(false);
    await wait(500);

    if (cancelRef.current) return;
    setRenderedLines([]);
    setAct1Cards([]);

    // ACT 2
    const act2Lines = useCase.act2;
    const act2CardsList: MemoryCard[] = useCase.act1.flatMap((l) => l.card ? [l.card] : []);

    for (const line of act2Lines) {
      if (cancelRef.current) return;
      setRenderedLines((prev) => [...prev, line]);
      const typeDuration = line.text.length * CHAR_DELAY + 80;
      await wait(typeDuration);
      // After memory.list, show all act2 cards staggered
      if (line.type === 'info' && line.text.includes('memories loaded')) {
        setAct2Cards(act2CardsList);
        setShowAct2Cards(true);
      }
      await wait(line.pauseAfter ?? LINE_GAP);
    }

    // End of act 2 — wait then loop
    if (cancelRef.current) return;
    await wait(500);
    setShowAct2Cards(false);
    await wait(400);

    if (!cancelRef.current) {
      play(tabIndex);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  // Start playing when tab changes
  useEffect(() => {
    play(activeTab);
    return () => { clearTimers(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Collect all currently-visible cards
  const visibleAct1Cards = showAct1Cards ? act1Cards : [];
  const visibleAct2Cards = showAct2Cards ? act2Cards : [];
  const allVisibleCards = [...visibleAct1Cards, ...visibleAct2Cards];
  const cardsLoaded = showAct2Cards;

  return (
    <section
      aria-label="Terminal demo: how LoreKit persists agent memory"
      className="w-full max-w-2xl mx-auto"
    >
      {/* Section heading */}
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
          {/* Traffic lights */}
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
              onClick={() => setActiveTab(i)}
              className={`relative px-3 py-1.5 rounded-md font-mono text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
                activeTab === i
                  ? 'text-[var(--color-content-primary)]'
                  : 'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]'
              }`}
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
          {/* Live indicator */}
          <div className="ml-auto flex items-center gap-1.5" aria-live="polite" aria-label={showAct2Cards ? 'Session B — memories loaded' : 'Session A — writing memories'}>
            <span className={`size-1.5 rounded-full transition-colors duration-300 ${showAct2Cards ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-success)]'} animate-pulse`} aria-hidden />
            <span className="font-mono text-[10px] text-[var(--color-content-tertiary)]">
              {showAct2Cards ? 'session B' : 'session A'}
            </span>
          </div>
        </div>

        {/* Terminal body */}
        <div className="px-4 py-4 min-h-[180px] space-y-1.5" aria-live="polite" aria-label="Terminal output">
          <AnimatePresence mode="popLayout">
            {renderedLines.map((line, i) => (
              <motion.div
                key={`${activeTab}-${i}-${line.text.slice(0, 12)}`}
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <TypewriterLine
                  text={line.text}
                  type={line.type}
                  reducedMotion={reducedMotion}
                  onDone={() => {}}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Memory cards area */}
        <div
          className={`border-t border-[var(--color-border)] px-4 py-4 min-h-[80px] transition-colors duration-300 ${
            cardsLoaded ? 'bg-[var(--color-accent-subtle)]/30' : 'bg-[var(--color-bg-raised)]'
          }`}
        >
          <p className="font-mono text-[10px] text-[var(--color-content-tertiary)] mb-3 uppercase tracking-widest">
            {cardsLoaded ? 'memories loaded' : 'memories written this session'}
          </p>
          <div className="flex flex-col gap-2">
            <AnimatePresence mode="popLayout">
              {allVisibleCards.map((card) => (
                <MemoryCard
                  key={`${activeTab}-${card.id}-${cardsLoaded ? 'loaded' : 'written'}`}
                  card={card}
                  loaded={cardsLoaded}
                />
              ))}
            </AnimatePresence>
            {allVisibleCards.length === 0 && (
              <p className="font-mono text-xs text-[var(--color-content-tertiary)] italic">
                — none yet —
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Caption */}
      <p className="mt-4 text-center font-mono text-xs text-[var(--color-content-tertiary)]">
        Memories survive session ends · Shared across Claude Code, Cursor, Codex
      </p>
    </section>
  );
}
