import type { ReactNode } from 'react';
import { Archive, BarChart3, Eye, GitPullRequest } from 'lucide-react';

import { cn } from '@/lib/cn';

import { SectionHeading } from './SectionHeading';
import { LANDING_SECTION_ID } from './sections';

/**
 * "03 / what you get" — four capabilities, each with a small picture of the
 * thing itself instead of an icon and a sentence.
 *
 * It replaces two things: the four generic feature cards the old page had
 * (which restated the hero in longer words, and were rightly removed), and the
 * standalone "Memory isn't free" panel, which is now the widest cell here. That
 * section stays in the page's own voice — the honest version of the claim is
 * the differentiating one — it just no longer needs a whole screen to itself.
 *
 * Every claim is the product's current behaviour, written to its real limits:
 *  - review comments become CANDIDATE lessons with a TTL, filtered for signal
 *    (`supabase/functions/mcp/webhook.ts`), not "durable lessons automatically";
 *  - grooming previews first and archives, never hard-deletes, and an archived
 *    lesson comes back with `lorekit restore` (`packages/cli/src/commands.mjs`);
 *  - the cost figures are the read/opened ratio `/insights` already computes;
 *  - the Lore Explorer lists, filters, edits and archives every lesson.
 * (Team sharing and tool coverage used to be a cell here too; "02 / how it
 * works" now tells that story in full, so it is not repeated.)
 * The visuals are illustrations of those behaviours, so they are `aria-hidden`
 * and carry no numbers that could be mistaken for a measurement.
 */
export function FeatureBento() {
  return (
    <section aria-labelledby={LANDING_SECTION_ID.whatYouGet} className="lk-reveal w-full max-w-5xl">
      <SectionHeading
        id={LANDING_SECTION_ID.whatYouGet}
        eyebrow="03 / what you get"
        title={
          <>
            Memory that earns its place{' '}
            <span className="lk-gradient-text block">in your context.</span>
          </>
        }
        lede="A store that learns from the work you already do, and tells you when a lesson has stopped paying for itself."
      />

      <div className="grid gap-5 md:grid-cols-3">
        <BentoCell
          className="md:col-span-2"
          highlighted
          icon={<BarChart3 className="size-4" />}
          title="Memory isn’t free, so we measure it"
          body="Every lesson delivered into a session costs tokens whether the agent uses it or not. LoreKit tracks how often each lesson is actually chosen versus merely delivered, estimates what your store costs you a month, and shows you the lore that is earning nothing."
          visual={<UtilityVisual />}
        />
        <BentoCell
          icon={<GitPullRequest className="size-4" />}
          title="Learns from your code reviews"
          body="Point a GitHub webhook at a repo and review comments become candidate lessons. Noise is filtered out, and a candidate expires unless it proves useful."
          visual={<ReviewVisual />}
        />
        <BentoCell
          icon={<Eye className="size-4" />}
          title="Every lesson in plain sight"
          body="Browse, search and filter everything your agents have learned in the dashboard — who wrote it, where it applies — and edit or archive it in place. Local lore is plain markdown you can grep."
          visual={<ExplorerVisual />}
        />
        <BentoCell
          className="md:col-span-2"
          icon={<Archive className="size-4" />}
          title="Groomed, never hard-deleted"
          body="Retention policies find the lore nobody has opened in months and archive it — previewed first, then reviewed by you or swept nightly. Anything archived comes back with one command."
          visual={<GroomVisual />}
        />
      </div>
    </section>
  );
}

function BentoCell({
  title,
  body,
  icon,
  visual,
  highlighted = false,
  className,
}: {
  title: string;
  body: string;
  icon: ReactNode;
  visual: ReactNode;
  /** The one cell per grid that gets the amber frame — see `lk-glow-frame`. */
  highlighted?: boolean;
  className?: string;
}) {
  return (
    <article
      className={cn(
        'group flex flex-col gap-5 overflow-hidden rounded-2xl p-6 transition-transform duration-200 ease-out hover:-translate-y-0.5',
        highlighted
          ? 'lk-glow-frame'
          : 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80 hover:border-[var(--color-accent)]/40',
        className,
      )}
    >
      <div aria-hidden className="min-h-0 flex-1">
        {visual}
      </div>
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-base font-semibold text-[var(--color-content-primary)]">
          <span aria-hidden className="text-[var(--color-accent)]">
            {icon}
          </span>
          {title}
        </h3>
        <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">{body}</p>
      </div>
    </article>
  );
}

// ─── Visuals ────────────────────────────────────────────────────────────────
// Static, presentational, and drawn from the same tokens and mono voice as the
// product UI. Widths are proportions for the picture, not data.

const MONO_PANEL =
  'rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/80 p-4 font-mono text-[11px] leading-relaxed';

function UtilityVisual() {
  const rows = [
    { key: 'fix/ssr-window', chosen: 'w-[78%]', idle: false },
    { key: 'style/exports', chosen: 'w-[46%]', idle: false },
    { key: 'ci/node-16-cache', chosen: 'w-[3%]', idle: true },
  ];

  return (
    <div className={MONO_PANEL}>
      <div className="mb-3 flex items-center justify-between text-[var(--color-content-secondary)]">
        <span className="uppercase tracking-widest">lesson utility</span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm bg-[var(--color-border)]" /> delivered
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm bg-[var(--color-accent)]" /> chosen
          </span>
        </span>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.key}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[var(--color-content-primary)]">{row.key}</span>
              {row.idle && (
                <span className="rounded border border-[var(--color-error)]/40 px-1.5 text-[10px] text-[var(--color-error)]">
                  earning nothing
                </span>
              )}
            </div>
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
              <div className={cn('absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)]', row.chosen)} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewVisual() {
  return (
    <div className="flex flex-col gap-2 font-mono text-[11px] leading-relaxed">
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/80 p-3">
        <p className="mb-1 text-[var(--color-content-secondary)]">
          <span className="text-[var(--color-scope-repo)]">@reviewer</span> on PR #42
        </p>
        <p className="font-sans text-xs text-[var(--color-content-primary)]">
          Use the custom logger here, not console.log.
        </p>
      </div>
      <div className="pl-4 text-[var(--color-content-secondary)]">↓ webhook</div>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] px-3 py-2">
        <span className="text-[var(--color-accent)]">review/logging</span>
        <span className="rounded border border-[var(--color-border)] px-1.5 text-[10px] text-[var(--color-content-secondary)]">
          candidate · expires
        </span>
      </div>
    </div>
  );
}

/** A slice of the Lore Explorer list: scope badge, key, and the agent that wrote it. */
function ExplorerVisual() {
  const rows = [
    { scope: 'repo', color: 'var(--color-scope-repo)', key: 'ci/pg-ready', agent: 'claude' },
    { scope: 'branch', color: 'var(--color-scope-branch)', key: 'fix/ssr-window', agent: 'cursor' },
    // Webhook lessons land under the delivering repo's scope, never global.
    { scope: 'repo', color: 'var(--color-scope-repo)', key: 'review/logging', agent: 'pr-webhook' },
  ];

  return (
    <div className={MONO_PANEL}>
      <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-2 py-1 text-[var(--color-content-secondary)]">
        <span aria-hidden>⌕</span>
        <span>search lore…</span>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            <span
              className="shrink-0 rounded border px-1.5 text-[10px]"
              style={{ color: row.color, borderColor: row.color }}
            >
              {row.scope}
            </span>
            <span className="truncate text-[var(--color-content-primary)]">{row.key}</span>
            <span className="ml-auto shrink-0 text-[10px] text-[var(--color-content-secondary)]">
              {row.agent}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroomVisual() {
  return (
    <div className={MONO_PANEL}>
      <p className="text-[var(--color-content-primary)]">
        <span className="select-none text-[var(--color-content-secondary)]">$ </span>
        lorekit groom --scope repo::acme/api --unseen-days 90
      </p>
      <p className="mt-2 text-[var(--color-scope-repo)]">3 lessons would be archived:</p>
      <ul className="pl-4 text-[var(--color-content-secondary)]">
        <li>repo::acme/api::ci/node-16-cache</li>
        <li>repo::acme/api::fix/old-webpack-alias</li>
        <li>repo::acme/api::style/legacy-tabs</li>
      </ul>
      <p className="mt-2 text-[var(--color-content-secondary)]">Re-run with --run to archive them.</p>
    </div>
  );
}
