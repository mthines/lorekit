import { GitBranch, GitCommitHorizontal, GitPullRequest, Github } from 'lucide-react';
import { originLinks, type MemoryOriginFields, type OriginLinkKind } from '@/lib/origin';

/**
 * The "recorded from" provenance rows of a memory's Metadata list.
 *
 * `ScopeBadge`/the `Repo` row already answer "where does this lesson APPLY".
 * These rows answer the different question "where did it COME FROM" — the pull
 * request, branch, and commit the agent was working in when it wrote the
 * lesson (migration 00046). A `global` lesson learned while reviewing a PR has
 * no repo in its scope, so this cannot be derived and has to be stored.
 *
 * The two never duplicate each other: the memory's `scope` is passed to
 * `originLinks`, which drops any origin the Repo row above already links (same
 * repo, or a `branch::` scope's own branch) — see `lib/origin.ts`.
 *
 * Renders `<div>` rows shaped exactly like the sibling metadata rows so it can
 * be dropped inside the existing `<dl>`; renders nothing when the memory
 * carries no origin (every pre-00046 memory, and any write with no git
 * context), so the section never shows an empty "unknown" state.
 */

const ROW_META: Record<OriginLinkKind, { label: string; Icon: typeof GitBranch }> = {
  'pull-request': { label: 'Pull request', Icon: GitPullRequest },
  branch: { label: 'Branch', Icon: GitBranch },
  commit: { label: 'Commit', Icon: GitCommitHorizontal },
  repo: { label: 'Recorded in', Icon: Github },
};

export function MemoryOrigin({ origin, scope }: { origin: MemoryOriginFields; scope?: string }) {
  const links = originLinks(origin, scope);
  if (links.length === 0) return null;

  return (
    <>
      {links.map(({ kind, label, url }) => {
        const { label: rowLabel, Icon } = ROW_META[kind];
        return (
          <div key={kind} className="flex items-center gap-2 text-xs">
            <Icon className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
            <dt className="text-[var(--color-content-tertiary)]">{rowLabel}</dt>
            <dd className="ml-auto min-w-0 truncate">
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[var(--color-content-secondary)] hover:text-[var(--color-accent)] hover:underline transition-colors duration-150"
                >
                  {label}
                </a>
              ) : (
                // No repository recorded, so there is nothing to link to — show
                // the value rather than hiding provenance we do have.
                <span className="font-mono text-[var(--color-content-secondary)]">{label}</span>
              )}
            </dd>
          </div>
        );
      })}
    </>
  );
}
