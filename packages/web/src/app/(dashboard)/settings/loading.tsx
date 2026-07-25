// Fallback for the active settings section. The header + nav rail live in the
// layout and stay put; only the content pane shows a skeleton matching a card.
export default function SettingsLoading() {
  return (
    <div className="h-72 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
  );
}
