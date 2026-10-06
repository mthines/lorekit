const STORES = [
  {
    name: 'Local',
    summary: 'No account, no network.',
    body: 'Markdown files under ~/.lorekit and <repo>/.lorekit — greppable, diffable, and yours. Commit them to share via git, or gitignore them to keep them private.',
  },
  {
    name: 'Hosted',
    summary: 'Shared across machines and teammates.',
    body: 'Every memory is personal by default; org sharing is opt-in. The free plan holds 5,000 active memories at 120 requests a minute.',
  },
  {
    name: 'Self-hosted',
    summary: 'Your own infrastructure.',
    body: 'The whole stack — MCP server, dashboard, database — deploys to your own Supabase and Vercel projects. MIT licensed.',
  },
] as const;

/**
 * Where the data physically sits, stated before anyone has to ask.
 *
 * "Is this a service that stores my repository's internals?" is the first
 * question a developer asks about a memory product and the last thing most
 * landing pages answer. All three answers are true of LoreKit today, and the
 * local one — which needs no account at all — is listed FIRST rather than as a
 * footnote, because burying the option that needs nothing from us would be
 * steering rather than informing.
 */
export function WhereLoreLives() {
  return (
    <section aria-labelledby="where-lore-lives" className="lk-reveal w-full max-w-4xl">
      <h2
        id="where-lore-lives"
        className="mb-2 text-center text-xl font-semibold text-[var(--color-content-primary)]"
      >
        Where your lore lives is your call
      </h2>
      <p className="mb-8 text-center text-sm text-[var(--color-content-secondary)]">
        The same memory tools run against any of the three.
      </p>

      <ul className="grid gap-4 sm:grid-cols-3">
        {STORES.map(({ name, summary, body }) => (
          <li
            key={name}
            className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5"
          >
            <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">
              {name}
            </h3>
            <p className="text-sm font-medium text-[var(--color-accent)]">{summary}</p>
            <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">
              {body}
            </p>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-center text-sm text-[var(--color-content-secondary)]">
        Start local and move up later —{' '}
        <code className="font-mono text-xs text-[var(--color-accent)]">lorekit migrate</code>{' '}
        previews the whole plan before it changes anything.
      </p>
    </section>
  );
}
