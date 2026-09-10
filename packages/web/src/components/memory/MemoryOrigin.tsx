import { GitBranch, GitCommitHorizontal, GitPullRequest, Github } from 'lucide-react';
import { originLinks, type MemoryOriginFields, type OriginLinkKind } from '@/lib/origin';
import { FilterableMetaValue } from '@/components/ui/FilterableMetaValue';
import type { FilterField } from '@/lib/filters';

/**
 * The "recorded from" provenance rows of a memory's Metadata list.
 *
 * `ScopeBadge`/the `Repo` row already answer "where does this lesson APPLY".
 * These rows answer the different question "where did it COME FROM" — the pull
 * request, branch, and commit the agent was working in when it wrote the
 * lesson (migration 00048). A `global` lesson learned while reviewing a PR has
 * no repo in its scope, so this cannot be derived and has to be stored.
 *
 * The two never duplicate each other: the memory's `scope` is passed to
 * `originLinks`, which drops any origin the Repo row above already links (same
 * repo, or a `branch::` scope's own branch) — see `lib/origin.ts`.
 *
 * Renders `<div>` rows shaped exactly like the sibling metadata rows so it can
 * be dropped inside the existing `<dl>`; renders nothing when the memory
 * carries no origin (every pre-00048 memory, and any write with no git
 * context), so the section never shows an empty "unknown" state.
 */

const ROW_META: Record<OriginLinkKind, { label: string; Icon: typeof GitBranch }> = {
  'pull-request': { label: 'Pull request', Icon: GitPullRequest },
  branch: { label: 'Branch', Icon: GitBranch },
  commit: { label: 'Commit', Icon: GitCommitHorizontal },
  repo: { label: 'Recorded in', Icon: Github },
};

/**
 * Which `FilterField` (see `lib/filters.ts`) each origin kind narrows to.
 * `commit` has no filter dimension (no `FilterField` names it), so it gets no
 * affordance — matching Decision D2's "no clean equals dimension" rule.
 */
const FILTERABLE_KIND_FIELD: Partial<Record<OriginLinkKind, 'repo' | 'branch' | 'pr'>> = {
  repo: 'repo',
  branch: 'branch',
  'pull-request': 'pr',
};

export function MemoryOrigin({
  origin,
  scope,
  onFilterOrigin,
  isValueActive,
}: {
  origin: MemoryOriginFields;
  scope?: string;
  /**
   * R3: when provided, the repo/branch/pull-request rows get a hover-reveal
   * "Filter by this" affordance (`FilterableMetaValue`) that calls back with
   * the `FilterField` + raw value to toggle into `?filters=`. Omitted by
   * standalone callers (e.g. a read-only origin summary elsewhere) that have
   * no filter bar to apply to.
   */
  onFilterOrigin?: (field: 'repo' | 'branch' | 'pr', value: string) => void;
  /**
   * Whether a given (field, value) is currently part of the applied filter
   * state (`isMetaValueActiveFilter`, `lib/filter-from-metadata.ts`) — drives
   * the same subtle accent-orange "applied" cue a committed `FilterPill`
   * uses. Only consulted alongside `onFilterOrigin` (a row with no filter
   * affordance has nothing to mark active either).
   */
  isValueActive?: (field: FilterField, value: string) => boolean;
}) {
  const links = originLinks(origin, scope);
  if (links.length === 0) return null;

  return (
    <>
      {links.map(({ kind, label, url }) => {
        const { label: rowLabel, Icon } = ROW_META[kind];
        const valueNode = url ? (
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
        );
        const filterField = FILTERABLE_KIND_FIELD[kind];
        // The filter VALUE must match the raw stored field (`origin_pr` is
        // numeric), not the display `label` — which for a pull request is the
        // formatted `#482`, not the bare number `toggleFilterValue` expects.
        const filterValue =
          kind === 'pull-request' && origin.origin_pr != null ? String(origin.origin_pr) : label;
        return (
          <div key={kind} className="flex items-center gap-2 text-xs">
            <Icon className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
            <dt className="text-[var(--color-content-tertiary)]">{rowLabel}</dt>
            <dd className="ml-auto min-w-0 truncate">
              {onFilterOrigin && filterField ? (
                <FilterableMetaValue
                  label={`Filter by ${rowLabel.toLowerCase()} "${label}"`}
                  onFilter={() => onFilterOrigin(filterField, filterValue)}
                  active={isValueActive?.(filterField, filterValue) ?? false}
                >
                  {valueNode}
                </FilterableMetaValue>
              ) : (
                valueNode
              )}
            </dd>
          </div>
        );
      })}
    </>
  );
}
