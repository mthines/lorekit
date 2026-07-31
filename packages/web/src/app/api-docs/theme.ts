/**
 * LoreKit theme for the Scalar API reference.
 *
 * Maps LoreKit's design tokens (packages/web/src/app/globals.css `@theme`) onto
 * Scalar's `--scalar-*` CSS variables so the docs page matches the dashboard:
 * deep-charcoal base, the amber signature accent, and cool-slate midtones.
 *
 * The Scalar page is served by a route handler and therefore does NOT inherit
 * the app's layout/fonts, so the tokens are restated here rather than referenced.
 * Kept in sync by hand — if the globals.css palette changes, update these too.
 */
export const LOREKIT_SCALAR_CSS = `
/* Base palette — mirrors globals.css @theme, dark-only like the dashboard */
.dark-mode {
  --scalar-color-1: #f0f2f7;   /* content-primary   */
  --scalar-color-2: #8892a4;   /* content-secondary */
  --scalar-color-3: #4f5668;   /* content-tertiary  */
  --scalar-color-accent: #f5a623;   /* amber signature */

  --scalar-background-1: #0d0e11;   /* bg          */
  --scalar-background-2: #13151a;   /* bg-raised   */
  --scalar-background-3: #1a1d24;   /* bg-elevated */
  --scalar-background-accent: #2a2010;   /* accent-subtle tint */

  --scalar-border-color: #2a2d38;

  /* Primary buttons / "try it" use the amber accent on the dark base */
  --scalar-button-1: #f5a623;
  --scalar-button-1-color: #0d0e11;
  --scalar-button-1-hover: #ffb733;

  /* HTTP method badges → LoreKit semantic palette */
  --scalar-color-green: #34d399;
  --scalar-color-red: #f87171;
  --scalar-color-yellow: #fbbf24;
  --scalar-color-blue: #60a5fa;
  --scalar-color-orange: #f5a623;
  --scalar-color-purple: #a78bfa;
}

/* Sidebar — a touch deeper than the content, like the app's nav rail */
.dark-mode .t-doc__sidebar {
  --scalar-sidebar-background-1: #0b0c0f;
  --scalar-sidebar-color-1: #f0f2f7;
  --scalar-sidebar-color-2: #8892a4;
  --scalar-sidebar-border-color: #1f2230;
  --scalar-sidebar-item-hover-background: #13151a;
  --scalar-sidebar-item-hover-color: #f0f2f7;
  --scalar-sidebar-item-active-background: #2a2010;   /* amber tint */
  --scalar-sidebar-color-active: #f5a623;
  --scalar-sidebar-search-background: #13151a;
  --scalar-sidebar-search-border-color: #2a2d38;
  --scalar-sidebar-search-color: #8892a4;
}

/* Match the dashboard's type (system fallbacks — no web-font fetch) */
.dark-mode {
  --scalar-font: 'Inter', ui-sans-serif, system-ui, sans-serif;
  --scalar-font-code: 'Fira Code', 'JetBrains Mono', ui-monospace, monospace;
}
`;
