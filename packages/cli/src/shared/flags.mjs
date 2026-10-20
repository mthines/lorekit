// Shared CLI flag-value parsers. Zero-dependency, following the package convention.

/**
 * Parse an optional non-negative-integer flag value.
 *
 * Returns `{ value: undefined }` when the flag was omitted, `{ value: N }` on a
 * valid whole number, or `{ error }` naming the flag on anything else — never
 * coerces a half-understood value (`12abc`, `1.5`) into a number silently.
 */
export function parseIntFlag(raw, name) {
  if (raw === undefined) return { value: undefined };
  if (!/^\d+$/.test(String(raw).trim())) {
    return { error: `--${name} must be a whole number, got ${JSON.stringify(String(raw))}` };
  }
  return { value: Number(String(raw).trim()) };
}

/**
 * The eight dimension filters a retention policy / inline groom call can
 * carry (migration 00093) — the CLI's flag-name ↔ field-name ↔ valid-mode
 * table. Mirrors `groomDimensionFilterProperties` in
 * `packages/schemas/src/shared/tool-catalog.ts` and `GROOM_DIMENSION_FIELDS`
 * in `supabase/functions/mcp/tools.ts`; kept as ONE list here (not three) so
 * `policy create`/`policy update`/`groom` cannot describe the dimensions
 * differently.
 */
const DIMENSIONS = [
  { flag: 'tags', field: 'tags', modes: ['any', 'all', 'none'] },
  { flag: 'source-agent', field: 'source_agent', modes: ['in', 'nin'] },
  { flag: 'trigger', field: 'trigger', modes: ['in', 'nin'] },
  { flag: 'kind', field: 'kind', modes: ['in', 'nin'] },
  { flag: 'host', field: 'host', modes: ['in', 'nin'] },
  { flag: 'origin-repo', field: 'origin_repo', modes: ['in', 'nin'] },
  { flag: 'origin-branch', field: 'origin_branch', modes: ['in', 'nin'] },
  { flag: 'origin-pr', field: 'origin_pr', modes: ['in', 'nin'] },
];

/**
 * Parse the eight retention dimension filters (`--tags`/`--kind`/`--host`/
 * `--trigger`/`--source-agent`/`--origin-repo`/`--origin-branch`/`--origin-pr`,
 * each with a `--<dim>-mode`) out of a parsed-args object.
 *
 * Comma-separated values — matching the existing `write --tags a,b,c`
 * convention. The minimal flag parser (`bin/lorekit.mjs`'s `parseArgs`) is
 * last-wins on a repeated flag, so comma-splitting is the established
 * multi-value shape in this CLI, not a new one invented here.
 *
 * `--<dim>-mode` is validated against that DIMENSION's own enum (`tags-mode`
 * accepts any/all/none; every other dimension accepts in/nin) — an invalid
 * value is rejected rather than silently forwarded to the RPC as a raw
 * Postgres enum error.
 *
 * With `clearable: true` (policy update), `--clear-<dim>` sends an explicit
 * `null` for the VALUE field only, and skips both the value and mode flags for
 * that dimension entirely — matching how `policy update --clear-min-age-days`
 * already ignores `--min-age-days` when both are passed. The MODE field is
 * left untouched by a clear: it is meaningless once the value is null, and
 * silently dropping it if the caller separately set it would be a second
 * surprise on top of the clear.
 *
 * Returns `{ conditions }` containing only the fields the caller actually
 * named — never a full 16-key object of undefineds, so a caller can spread it
 * straight into a request body without a second `stripUndefined` pass losing
 * an intentional `null` — or `{ error }` naming the offending flag.
 */
export function parseDimensionConditions(args, { clearable = false } = {}) {
  const conditions = {};
  for (const { flag, field, modes } of DIMENSIONS) {
    if (clearable && args[`clear-${flag}`]) {
      conditions[field] = null;
      continue;
    }
    const raw = args[flag];
    if (raw !== undefined) {
      conditions[field] = String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    const modeRaw = args[`${flag}-mode`];
    if (modeRaw !== undefined) {
      if (!modes.includes(modeRaw)) {
        return { error: `--${flag}-mode must be one of ${modes.join('|')}, got ${JSON.stringify(String(modeRaw))}` };
      }
      conditions[`${field}_mode`] = modeRaw;
    }
  }
  return { conditions };
}

/**
 * The dimensions the read commands (`list`, `search`) filter on, in the order
 * they are checked, with an example value list for the usage error. Each
 * reuses its {@link DIMENSIONS} row for the field name and the valid modes, so
 * `--kind-mode` accepts exactly what `policy create --kind-mode` accepts.
 */
const READ_FILTERS = [
  { flag: 'tags', example: 'loop::aw-lessons,perf' },
  { flag: 'kind', example: 'lesson,bus' },
  { flag: 'host', example: 'reviewer,aw' },
];

/**
 * Parse the read commands' dimension filters — `--tags a,b [--tags-mode
 * any|all|none]`, `--kind a,b [--kind-mode in|nin]` and `--host a,b
 * [--host-mode in|nin]` on `list` and `search`.
 *
 * Returns `{ filters }` holding only the dimensions that were given, each as a
 * value array plus its `*_mode` — defaulting to the dimension's first mode
 * (`any` for tags, `in` for kind/host), the hosted list's own defaults, so
 * offline and remote agree — or `{ error }` naming the offending flag.
 *
 * Stricter than {@link parseDimensionConditions} on purpose: a bare `--tags`
 * with no value, or a `--kind-mode` with no `--kind`, is rejected rather than
 * quietly listing everything. That silent no-op is how `list --tags x` used to
 * behave (`tags` was a known flag for `write`, so it parsed cleanly and
 * filtered nothing).
 */
export function parseReadFilters(args) {
  const filters = {};
  for (const { flag, example } of READ_FILTERS) {
    const { field, modes } = DIMENSIONS.find((d) => d.flag === flag);
    const raw = args[flag];
    const modeRaw = args[`${flag}-mode`];

    if (modeRaw !== undefined && !modes.includes(modeRaw)) {
      return { error: `--${flag}-mode must be one of ${modes.join('|')}, got ${JSON.stringify(String(modeRaw))}` };
    }
    if (raw === undefined) {
      if (modeRaw !== undefined) return { error: `--${flag}-mode needs --${flag} <a,b>` };
      continue;
    }

    const values = typeof raw === 'string'
      ? [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))]
      : [];
    if (values.length === 0) {
      return { error: `--${flag} needs a comma-separated list, e.g. --${flag} ${example}` };
    }
    filters[field] = values;
    filters[`${field}_mode`] = modeRaw ?? modes[0];
  }
  return { filters };
}
