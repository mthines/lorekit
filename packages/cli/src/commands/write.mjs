// `lorekit write <scope::key> [value]` — create or update a memory from the CLI.
//
// Two positional shapes are accepted:
//   write <scope::key> [value]        — canonical form: ONE token, exactly the
//                                       format `list`/`search` print and this
//                                       command echoes back, so a key can be
//                                       copy-pasted straight from any output
//   write <scope> <key> [value]       — the explicit two-positional form, kept
//                                       because it is unambiguous by position
//   write --scope <s> --key <k> [value]
//                                     — flags win outright; the ONLY way to
//                                       express a key that itself contains `::`
//
// Disambiguation is `resolveScopeKeyArgs`'s job (`lessons-pure.mjs`) and is
// gated on scope VALIDITY, never on a naive `::` split: `write repo::o/n k v`
// keeps `repo::o/n` whole because it is already a valid scope, while
// `write global::k v` splits because `global::k` is not. The scope is then
// validated with `scopeIssue` before any store is touched.
//
// When no value is supplied as a positional or via --value, the command reads
// the full stdin (useful for piping). In all cases the value is required — an
// empty string produces a usage error (prefer `lorekit delete` to remove a key).
//
// Optional write-metadata flags mirror the hosted `memory.write` parameters:
//   --tags <a,b,c>         Comma-separated tag list (default: no tags)
//   --source-agent <name>  Which agent recorded this lesson (default: none)
//   --trigger <slug>       What prompted the write (default: none)
//   --ttl-days <n>         Days until the memory auto-expires (1–365). When
//                          omitted, a configured default may apply — see below.
//   --clear-ttl            Remove any existing expiry (make the memory permanent)
//   --org <slug>           Write to this org (remote only)
//
// Provenance — where the lesson is being recorded FROM. Derived automatically
// from git + the CI environment (repo, branch, commit, and the pull request
// from LOREKIT_PR / GITHUB_REF); the dashboard turns it into links back to the
// PR, branch and commit. Each can be overridden, and the whole thing skipped:
//   --origin-repo <owner/name>  Override the derived repository
//   --origin-branch <name>      Override the derived branch
//   --origin-commit <sha>       Override the derived commit
//   --origin-pr <n>             The pull request this lesson came out of
//   --no-origin                 Record no provenance at all
//
// Default TTL. A write that passes neither --ttl-days nor --clear-ttl picks up
// whatever the config layers configured for its scope (`ttl.default` and
// `scope.defaults.<prefix>.ttl_days`; see control.mjs). Precedence is explicit
// flag > config > permanent, so a flag is always the last word and --clear-ttl
// is how you say "permanent" against a repo that defaults to expiring. The
// resolved source is reported in the confirmation line and on the telemetry
// span, because a TTL nobody typed is exactly the kind of thing that should
// never be silent.
//
// Store targeting (default: remote if configured, else local):
//   --remote               Force write to the remote store
//   --local                Force write to the local offline store
//
// The command writes to ONE store at a time (unlike the read commands that show
// both). Dual-write would silently create a divergence on subsequent `diff`.
//
// Output: a confirmation line (human) or a JSON object (--json) with the
// resolved scope, key, store written, and a boolean `inserted` (true = created,
// false = updated) when the remote reports it.
import process from 'node:process';
import { resolveProjectRoot } from '../shared/config.mjs';
import { loadControl, resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { log, err, heading, status, c } from '../shared/util.mjs';
import { resolveScopeKeyArgs, scopeIssue } from '../shared/lessons-view.mjs';
import { deriveOrigin, mergeOrigin } from '../shared/origin.mjs';
import { parseTtlDays, resolveDefaultTtlDays } from '../store/ttl.mjs';

// Read all of stdin to a string. Resolves to '' when stdin IS a TTY (no pipe).
function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trimEnd()));
    process.stdin.resume();
  });
}

export async function write(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  // ── Parse positionals ─────────────────────────────────────────────────────
  // The shared `resolveScopeKeyArgs` decides between the shorthand and the
  // two-positional form (and honours --scope/--key), and reports how many
  // positionals it took so the VALUE is read from the right index in both:
  //   write <scope::key> <value>     → consumed 1, value at _[2]
  //   write <scope> <key> <value>    → consumed 2, value at _[3]
  // `args._[0]` is the command token, so the command's own positionals start
  // at index 1.
  const positionals = args._.slice(1);
  const { scope, key, consumed } = resolveScopeKeyArgs(positionals, {
    scope: args.scope,
    key: args.key,
  });
  const positionalValue =
    typeof positionals[consumed] === 'string' ? positionals[consumed] : undefined;

  // Validate the scope BEFORE the missing-key check, the value, or any store.
  // Order matters: a bad scope is the ROOT cause and every other complaint is
  // downstream noise. `write foo "asd"` parses as scope `foo` + key `asd` with
  // no value left, and used to report "a non-empty value is required" — three
  // steps removed from the actual mistake. The offline store accepts any
  // string, so this is also the only thing standing between a local write and
  // a scope the hosted API would reject with a 400. It is a PARTIAL gate, not
  // an equivalent one: `scopeIssue` checks the segment SHAPE (`[^/]+/[^/]+`)
  // where `packages/mcp-core/src/scope/scope.ts` additionally restricts the CHARSET
  // (`[\w.-]+/[\w.-]+`), so `repo::a b/c,d` and `branch::o/r::a",x` pass here
  // and still 400 remotely. Tightening the CLI to match would also change what
  // `lint`'s malformed-scope rule flags in existing offline stores, so it is a
  // deliberate follow-up rather than a silent widening of this check.
  const badScope = scope ? scopeIssue(scope) : null;
  if (badScope) {
    err(`${c.red('Error:')} invalid scope ${c.cyan(scope)} — ${badScope}`);
    err(`Valid scopes: global | project::<name> | repo::<owner>/<name> | branch::<owner>/<name>::<branch>`);
    err(`Run ${c.cyan('lorekit write --help')} for options.`);
    return 1;
  }

  if (!scope || !key) {
    err(`${c.red('Usage:')} lorekit write <scope::key> <value> [options]`);
    err(`       lorekit write <scope> <key> <value> [options]`);
    err(`Both a scope and a key are required. Run ${c.cyan('lorekit write --help')} for options.`);
    return 1;
  }

  // Leftover positionals are an error, exactly as in `show` — the difference is
  // only in how many this command legitimately consumes: the parser's `consumed`
  // plus ONE for the value, and zero for the value when `--value` already named
  // it. Without this, `--scope` (which makes the parser take one fewer
  // positional) silently shifted everything left: `write global my-key "v"
  // --scope global` resolved scope `global`, key `global`, value `my-key` — it
  // stored the wrong key, dropped the value, and exited 0. A wrong write that
  // reports success is worse than any usage error, so the leftover is named.
  const valueSlots = typeof args.value === 'string' ? 0 : 1;
  if (positionals.length > consumed + valueSlots) {
    const stray = positionals[consumed + valueSlots];
    err(`${c.red('Error:')} unexpected argument ${c.cyan(stray)}`);
    err(`Parsed scope ${c.cyan(scope)} and key ${c.cyan(key)} from the arguments before it.`);
    err(`Run ${c.cyan('lorekit write --help')} for options.`);
    return 1;
  }

  // ── Resolve value: flag → positional → stdin ───────────────────────────────
  let value;
  if (typeof args.value === 'string') {
    value = args.value;
  } else if (positionalValue !== undefined) {
    value = positionalValue;
  } else {
    value = await readStdin();
  }

  if (!value) {
    err(`${c.red('Error:')} a non-empty value is required`);
    err(`Pipe a value via stdin, pass it as a positional, or use --value <text>.`);
    err(`Run ${c.cyan('lorekit write --help')} for options.`);
    return 1;
  }

  // ── Parse optional metadata flags ─────────────────────────────────────────
  const tags = args.tags ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
  const sourceAgent = typeof args['source-agent'] === 'string' ? args['source-agent'] : undefined;
  const trigger = typeof args.trigger === 'string' ? args.trigger : undefined;
  // Taxonomy overrides. Omitted → the server infers kind/host from a
  // `loop::<host>-lessons` tag, so a tagged write needs neither flag.
  const kind = typeof args.kind === 'string' ? args.kind : undefined;
  const host = typeof args.host === 'string' ? args.host : undefined;
  // `--ttl-days` is validated HERE, at the flag seam, rather than being left to the
  // store: a truthiness test silently swallowed `--ttl-days 0` (falsy) and
  // `--ttl-days abc` (NaN, dropped again by the `ttl_days` spread further down), so
  // both exited 0 having written no expiry while `--ttl-days 999` correctly errored.
  // The seam matters as much as the check — `store/remote.mjs` forwards `ttl_days`
  // verbatim and `JSON.stringify(NaN)` would reach the server as `null`, so a
  // store-side fix would leave the remote path silently broken. Mirrors how
  // `--origin-pr` is handled below: an explicitly supplied value is a caller
  // assertion, so a malformed one is a usage error.
  let ttlDays;
  if (args['ttl-days'] !== undefined) {
    // A bare `--ttl-days` with no value parses as boolean `true` (see parseArgs);
    // feed NaN so the shared validator rejects it instead of silently meaning 1 day.
    const rawTtlDays = args['ttl-days'] === true ? NaN : args['ttl-days'];
    try {
      ttlDays = parseTtlDays(rawTtlDays);
    } catch (e) {
      err(`${c.red('Error:')} --ttl-days is invalid — ${(e && e.message) || String(e)}`);
      return 1;
    }
  }
  const clearTtl = Boolean(args['clear-ttl']);

  // Neither flag given → fall back to the scope's configured default, if any.
  // `--clear-ttl` deliberately suppresses it: "make this permanent" has to mean
  // permanent, not "permanent unless the repo config disagrees". Config is read
  // through the same loadControl the hooks use, so the default the nudge advises
  // and the default this command applies can never diverge.
  let ttlSource = ttlDays ? 'flag' : 'none';
  if (ttlDays === undefined && !clearTtl) {
    const configured = resolveDefaultTtlDays(scope, loadControl(root, { env }));
    if (configured != null) {
      ttlDays = configured;
      ttlSource = 'config';
    }
  }

  // What gets REPORTED is the outcome, not the input. `--clear-ttl` beats
  // `--ttl-days` inside resolveExpiresAt (and in memory_write, migrations
  // 00030/00031), so `--ttl-days 7 --clear-ttl` persists a permanent row —
  // yet ttlDays/ttlSource still described the flag the user typed, so the
  // human output claimed "expires in 7 days" and --json reported
  // ttl_days 7 / ttl_source "flag" for a row whose expires_at is null.
  // Kept separate from ttlDays on purpose: writeArgs below spreads
  // `...(ttlDays ? { ttl_days } : {})`, and nulling ttlDays itself would
  // silently stop sending ttl_days to the remote RPC — a wire change nobody
  // asked for. The precedence lives in one place; this only mirrors it.
  const reportedTtlDays = clearTtl ? null : (ttlDays ?? null);
  const reportedTtlSource = clearTtl ? 'none' : ttlSource;

  const orgSlug = typeof args.org === 'string' ? args.org : undefined;

  // ── Provenance ────────────────────────────────────────────────────────────
  // Derived from git + CI unless --no-origin; explicit --origin-* flags win.
  // A field that is neither supplied nor derivable is omitted, never sent as
  // null — the server keeps the last KNOWN origin per field, so an omission
  // must not erase what an earlier write recorded.
  // An explicitly supplied PR number is a caller assertion, so a malformed one
  // is a usage error — silently ignoring it would record no provenance while
  // the user believes they set it. Derived values, by contrast, degrade quietly.
  let originPr = null;
  if (args['origin-pr'] !== undefined) {
    originPr = Number(args['origin-pr']);
    if (!Number.isInteger(originPr) || originPr < 1) {
      err(`${c.red('Error:')} --origin-pr must be a positive integer (got ${args['origin-pr']})`);
      return 1;
    }
  }

  const origin = args['no-origin']
    ? {}
    : mergeOrigin(deriveOrigin({ cwd: root, env }), {
        origin_repo: typeof args['origin-repo'] === 'string' ? args['origin-repo'] : null,
        origin_branch: typeof args['origin-branch'] === 'string' ? args['origin-branch'] : null,
        origin_commit: typeof args['origin-commit'] === 'string' ? args['origin-commit'] : null,
        origin_pr: originPr,
      });

  // ── Resolve deny constraints ───────────────────────────────────────────────
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  // ── Resolve stores and pick the target ────────────────────────────────────
  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  const forceRemote = Boolean(args.remote);
  const forceLocal = Boolean(args.local);
  const remoteUsable = !remoteDenied && remote.usable();

  if (forceRemote && forceLocal) {
    err(`${c.red('Error:')} --remote and --local are mutually exclusive`);
    return 1;
  }

  let targetStore, storeName;

  if (forceRemote) {
    if (remoteDenied) {
      err(`${c.red('Error:')} remote store is disabled by deny constraint (${remoteDenied.source})`);
      return 1;
    }
    if (!remote.usable()) {
      err(`${c.red('Error:')} remote store is not configured — ${remoteUnavailableReason(connection)}`);
      return 1;
    }
    targetStore = remote;
    storeName = 'remote';
  } else if (forceLocal) {
    if (localDenied) {
      err(`${c.red('Error:')} local store is disabled by deny constraint (${localDenied.source})`);
      return 1;
    }
    targetStore = local;
    storeName = 'local';
  } else if (remoteUsable) {
    targetStore = remote;
    storeName = 'remote';
  } else if (!localDenied) {
    targetStore = local;
    storeName = 'local';
  } else {
    err(`${c.red('Error:')} no writable store available`);
    err(`Remote: ${remoteUnavailableReason(connection)}`);
    if (localDenied) err(`Local:  disabled by deny constraint (${localDenied.source})`);
    return 1;
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  const writeArgs = {
    scope,
    key,
    value: String(value),
    ...(tags.length ? { tags } : {}),
    ...(sourceAgent ? { source_agent: sourceAgent } : {}),
    ...(trigger ? { trigger } : {}),
    ...(kind ? { kind } : {}),
    ...(host ? { host } : {}),
    ...(ttlDays ? { ttl_days: ttlDays } : {}),
    ...(clearTtl ? { clear_ttl: true } : {}),
    ...(orgSlug ? { org: orgSlug } : {}),
    ...origin,
  };

  let result;
  try {
    result = await targetStore.write(writeArgs);
  } catch (e) {
    err(`${c.red('Error:')} ${(e && e.message) || String(e)}`);
    return 1;
  }

  if (!result || result.ok === false) {
    const detail = result && result.error ? result.error : 'unknown error';
    err(`${c.red('Error writing to')} ${storeName} store: ${detail}`);
    return 1;
  }

  // `inserted` is additive from the remote (memory_write RPC 00011). Local store
  // returns { ok, entry } with no explicit field; treat absence as unknown.
  const inserted = result.inserted ?? null;

  if (args.json) {
    log(JSON.stringify({
      scope,
      key,
      store: storeName,
      inserted,
      value: String(value),
      tags,
      source_agent: sourceAgent || null,
      trigger: trigger || null,
      ttl_days: reportedTtlDays,
      ttl_source: reportedTtlSource,
      origin,
    }, null, 2));
  } else {
    const verb = inserted === true ? 'Created' : inserted === false ? 'Updated' : 'Written';
    heading('LoreKit memory written');
    log(`  ${c.dim('store')}  ${storeName}`);
    log(`  ${c.dim('scope')}  ${scope}`);
    log(`  ${c.dim('key')}    ${key}`);
    if (tags.length) log(`  ${c.dim('tags')}   ${tags.join(', ')}`);
    // Name the source. A TTL the caller typed needs no explanation; one that came
    // from a config file two directories up does, or the first surprise is a
    // memory that quietly vanished.
    if (reportedTtlDays) {
      const suffix = reportedTtlSource === 'config' ? c.dim(' (from config)') : '';
      log(`  ${c.dim('expires')} in ${reportedTtlDays} day${reportedTtlDays === 1 ? '' : 's'}${suffix}`);
    }
    status('pass', verb, `${scope}::${key}`);
    log('');
  }

  return {
    exitCode: 0,
    'lorekit.cli.write.store': storeName,
    'lorekit.cli.write.inserted': inserted,
    'lorekit.cli.write.has_tags': tags.length > 0,
    'lorekit.cli.write.has_ttl': Boolean(reportedTtlDays),
    'lorekit.cli.write.ttl_source': reportedTtlSource,
    'lorekit.cli.write.clear_ttl': clearTtl,
  };
}
