// Route-level loading fallback — shown on first navigation before the server
// component resolves. Title renders as real text so it's immediately readable.
export default function OnboardingLoading() {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Getting started
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Everything you need to connect LoreKit to your agents and repos — in one place.
        </p>
      </div>

      {/* Checklist skeleton */}
      <div className="h-64 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
    </div>
  );
}
