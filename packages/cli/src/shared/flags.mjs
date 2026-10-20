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
 * An example value list per dimension, for the read commands' usage error.
 * The read commands accept every {@link DIMENSIONS} row — the same eight
 * filters `policy create` and `groom` take, with the same field names and the
 * same valid modes, so `--trigger-mode` accepts exactly what
 * `policy create --trigger-mode` accepts.
 */
const READ_FILTER_EXAMPLES = {
  tags: 'loop::aw-lessons,perf',
  'source-agent': 'claude,aw',
  trigger: 'stuck-loop,manual',
  kind: 'lesson,bus',
  host: 'reviewer,aw',
  'origin-repo': 'mthines/lorekit',
  'origin-branch': 'main,feat/x',
  'origin-pr': '482,511',
};

/**
 * One `--origin-pr` value as the canonical digits the hosted route compares,
 * or `null` when it is not a pull request number. A leading `#` is accepted —
 * the dashboard writes PRs as `#482` — and `007` becomes `7`, because the
 * hosted filter compares numerically (`lorekit_match_int`, migration 00066).
 */
export function canonicalPrNumber(raw) {
  const digits = String(raw).trim().replace(/^#/, '');
  if (!/^\d+$/.test(digits)) return null;
  return String(Number(digits));
}

/**
 * Parse the read commands' dimension filters — `--tags a,b [--tags-mode
 * any|all|none]`, and `--kind`, `--host`, `--trigger`, `--source-agent`,
 * `--origin-repo`, `--origin-branch`, `--origin-pr a,b`, each with a
 * `--<dim>-mode in|nin` — on `list` and `search`.
 *
 * Returns `{ filters }` holding only the dimensions that were given, each as a
 * value array plus its `*_mode` — defaulting to the dimension's first mode
 * (`any` for tags, `in` for the rest), the hosted list's own defaults, so
 * offline and remote agree — or `{ error }` naming the offending flag.
 *
 * Stricter than {@link parseDimensionConditions} on purpose: a bare `--tags`
 * with no value, a `--kind-mode` with no `--kind`, or an `--origin-pr` that is
 * not a number is rejected rather than quietly listing everything. Each of
 * those would otherwise filter nothing: `list --tags x` used to parse cleanly
 * (a known flag for `write`) and be ignored, and the hosted route DROPS a
 * non-numeric PR value, then applies no PR filter once the list is empty.
 */
export function parseReadFilters(args) {
  const filters = {};
  for (const { flag, field, modes } of DIMENSIONS) {
    const raw = args[flag];
    const modeRaw = args[`${flag}-mode`];

    if (modeRaw !== undefined && !modes.includes(modeRaw)) {
      return { error: `--${flag}-mode must be one of ${modes.join('|')}, got ${JSON.stringify(String(modeRaw))}` };
    }
    if (raw === undefined) {
      if (modeRaw !== undefined) return { error: `--${flag}-mode needs --${flag} <a,b>` };
      continue;
    }

    let values = typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
    if (values.length === 0) {
      return { error: `--${flag} needs a comma-separated list, e.g. --${flag} ${READ_FILTER_EXAMPLES[flag]}` };
    }
    if (field === 'origin_pr') {
      const bad = values.find((v) => canonicalPrNumber(v) === null);
      if (bad !== undefined) {
        return { error: `--origin-pr takes pull request numbers, e.g. --origin-pr 482,511 — got ${JSON.stringify(bad)}` };
      }
      values = values.map(canonicalPrNumber);
    }
    filters[field] = [...new Set(values)];
    filters[`${field}_mode`] = modeRaw ?? modes[0];
  }
  return { filters };
}
