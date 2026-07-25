// Segment-specific skeleton for Settings → Audit Logs, shown while
// listAuditLog() resolves. Mirrors the shape of the loaded feed (filter pills
// + rows) rather than the generic settings/loading.tsx panel skeleton, so the
// layout doesn't jump once data arrives — same rationale as ActivityFeed's
// FeedSkeleton in the activity page.
export default function AuditLogLoading() {
  return (
    <div
      role="status"
      aria-label="Loading audit logs"
      className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4"
    >
      <div className="mb-4 flex items-start gap-3 border-b border-[var(--color-border)] pb-4">
        <div className="size-9 shrink-0 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
        <div className="flex flex-col gap-2">
          <div className="h-3.5 w-28 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
          <div className="h-3 w-64 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-7 w-24 animate-pulse rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
          ))}
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
        ))}
      </div>
    </div>
  );
}
