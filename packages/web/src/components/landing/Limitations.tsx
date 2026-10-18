import { SectionHeading } from './SectionHeading';
import { LANDING_SECTION_ID } from './sections';

const LIMITS = [
  'It doesn’t read your codebase. It stores what your agent writes to it, and nothing else.',
  'It doesn’t make an agent smarter on its own. If nothing writes a lesson, there is nothing to read — which is why the plugins wire lifecycle hooks instead of leaving it to the agent’s discretion.',
  'It doesn’t model beliefs or propagate confidence between memories. It stores and delivers lessons; reasoning over them is left to your agent.',
  'It doesn’t detect contradictions, or invalidate a lesson when something it depends on changes. Grooming archives lessons nobody uses — it doesn’t catch a lesson that is used but wrong.',
  'It can surface a lesson you didn’t need. Scopes narrow what an agent sees, grooming prunes what has stopped earning its place, and every memory is visible to you in the dashboard.',
  'Codex support is experimental. Claude Code and Cursor are the supported paths; anything speaking MCP works too.',
  'There is no paid tier yet. If the free limits ever change, your lore exports to plain markdown files you own.',
] as const;

/**
 * The limits, in the product's own voice.
 *
 * This is the section a sceptical developer screenshots, and it is cheaper to
 * write it ourselves than to have someone discover each line on day one. Every
 * entry names something that is true right now — an overstated claim withdrawn
 * later reads as a retraction, while a limit removed later reads as progress.
 *
 * It is deliberately the plainest section on the page: no amber frame, no
 * gradient phrase. Dressing the limits up would read as spin.
 */
export function Limitations() {
  return (
    <section aria-labelledby={LANDING_SECTION_ID.limitations} className="lk-reveal w-full max-w-3xl">
      <SectionHeading
        id={LANDING_SECTION_ID.limitations}
        eyebrow="05 / the fine print, up front"
        title="What LoreKit doesn’t do"
        lede="Better you read it here than find it on day one."
      />
      <ul className="flex flex-col divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80">
        {LIMITS.map((limit) => (
          <li
            key={limit}
            className="flex gap-4 px-6 py-4 text-sm leading-relaxed text-[var(--color-content-secondary)]"
          >
            <span aria-hidden className="select-none font-mono text-[var(--color-content-secondary)]">
              —
            </span>
            {limit}
          </li>
        ))}
      </ul>
    </section>
  );
}
