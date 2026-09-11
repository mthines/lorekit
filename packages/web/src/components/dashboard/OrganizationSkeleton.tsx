/**
 * Loading placeholders for the Organization settings surface — the route-level
 * Suspense fallback (`settings/organization/page.tsx`) and the three async
 * sections inside `OrganizationManager` (members, invites, shared scopes).
 *
 * Each skeleton mirrors the row it stands in for — same wrapper classes, same
 * leading glyph box, same trailing control — so the section keeps its shape
 * when the data lands instead of collapsing a one-line "Loading…" string into a
 * stack of 60px rows.
 *
 * The pulse blocks are `aria-hidden` (decorative until the data arrives) and
 * each section wrapper carries the `role="status"` that announces the load,
 * matching `LessonCardSkeleton`/`LoreExplorerSkeleton` in the lore surface.
 * Widths are fixed px so the blocks are stable between renders.
 */

const ROW =
  'flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2.5';
// No radius here: this repo has no `tailwind-merge` (see `lib/cn.ts`), so a
// radius baked in would be a second, conflicting `rounded-*` on every call site
// that needs a different one — decided by CSS source order, not by the class
// list. Each block states its own.
const BLOCK = 'animate-pulse bg-[var(--color-bg-elevated)]';

/** Bar widths — varied so each stack reads as content, not a table column. */
const ORG_NAME_WIDTHS = [96, 72];
const MEMBER_NAME_WIDTHS = [88, 132, 104];
const SCOPE_WIDTHS = [188, 148];

/**
 * One row of the master list (`OrgListView`): the size-9 org glyph, the
 * name/slug pair, a role badge and the chevron.
 */
function OrgListRowSkeleton({ width }: { width: number }) {
  return (
    <div
      aria-hidden
      className="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2.5"
    >
      <div className={`size-9 shrink-0 rounded-lg ${BLOCK}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className={`h-4 rounded ${BLOCK}`} style={{ width: `${width}px` }} />
        <div className={`h-3 w-16 rounded ${BLOCK}`} />
      </div>
      <div className={`h-5 w-14 shrink-0 rounded-md ${BLOCK}`} />
      <div className={`size-4 shrink-0 rounded ${BLOCK}`} />
    </div>
  );
}

/** The organization list, for the page's Suspense fallback. */
export function OrgListSkeleton() {
  return (
    <div role="status" aria-label="Loading organizations" className="flex flex-col gap-2">
      {ORG_NAME_WIDTHS.map((width) => (
        <OrgListRowSkeleton key={width} width={width} />
      ))}
    </div>
  );
}

/**
 * The members list. `manageable` is the viewer's own capability, known before
 * the fetch resolves: a role-managing viewer gets rows sized for the `min-h-11`
 * role `<select>` plus a remove button, everyone else the shorter badge row —
 * so the placeholder resolves to the height the real rows will have.
 */
export function OrgMembersSkeleton({ manageable }: { manageable: boolean }) {
  return (
    <div role="status" aria-label="Loading members" className="flex flex-col gap-1.5">
      {MEMBER_NAME_WIDTHS.map((width) => (
        // `flex-wrap` only here: the real member row carries it (the role select
        // and remove button drop to a second line on a narrow viewport), while
        // the invite and scope rows do not.
        <div key={width} aria-hidden className={`${ROW} flex-wrap`}>
          <div className={`size-6 shrink-0 rounded-full ${BLOCK}`} />
          <div className={`h-4 rounded ${BLOCK}`} style={{ width: `${width}px` }} />
          <div className="ml-auto flex items-center gap-3">
            {manageable ? (
              <>
                <div className={`h-11 w-24 shrink-0 rounded-lg ${BLOCK}`} />
                <div className={`size-8 shrink-0 rounded-lg ${BLOCK}`} />
              </>
            ) : (
              <div className={`h-5 w-16 shrink-0 rounded-md ${BLOCK}`} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A single pending-invite row — the email line over its status/role meta line,
 * with the Revoke button. One row, not a stack: most orgs have no pending
 * invites, so a taller placeholder would promise rows that never arrive.
 */
export function OrgInvitesSkeleton() {
  return (
    <div role="status" aria-label="Loading invites" className="flex flex-col gap-1.5">
      <div aria-hidden className={ROW}>
        <div className={`size-4 shrink-0 rounded ${BLOCK}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className={`h-4 w-44 rounded ${BLOCK}`} />
          <div className={`h-3 w-24 rounded ${BLOCK}`} />
        </div>
        <div className={`h-8 w-[72px] shrink-0 rounded-lg ${BLOCK}`} />
      </div>
    </div>
  );
}

/** The bound-scope rows — mono scope string plus the Unbind button. */
export function OrgScopesSkeleton() {
  return (
    <div role="status" aria-label="Loading shared scopes" className="flex flex-col gap-1.5">
      {SCOPE_WIDTHS.map((width) => (
        <div key={width} aria-hidden className={ROW}>
          <div className={`size-4 shrink-0 rounded ${BLOCK}`} />
          <div className={`h-4 rounded ${BLOCK}`} style={{ width: `${width}px` }} />
          <div className={`ml-auto h-8 w-[92px] shrink-0 rounded-lg ${BLOCK}`} />
        </div>
      ))}
    </div>
  );
}
