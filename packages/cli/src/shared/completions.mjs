// Shell completion: the ONE place the completion SURFACE is described, and the
// helpers that write / remove the generated scripts on disk.
//
// The `completion` command (src/commands/completion.mjs), `install` and
// `uninstall` all build on this module. It is deliberately dependency-light — it
// does NOT import the command registry (commands.mjs), because `install` imports
// this module and commands.mjs imports `install`, so pulling the registry in
// here would close an import cycle. The registry stays the source of truth for
// which commands EXIST; a test (test/completion.test.mjs) cross-checks that this
// spec covers every human command and references only real flags, so the two
// can never silently drift.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, writeFileAtomic } from './config.mjs';

// Shells we generate for. zsh and fish were the request; bash is intentionally
// absent (its completion model is fiddlier and nobody asked). Adding one is a
// new renderer plus a `completionTargets` case — nothing else changes.
export const COMPLETION_SHELLS = ['zsh', 'fish'];

// Flag metadata, shared across commands so a flag's description and value-type
// are stated once. `arg` names the value a flag takes (absent ⇒ a boolean flag
// that takes none); `complete` selects a DYNAMIC candidate source the generated
// script calls back for; `values` is a STATIC candidate list; `short` is the
// one-letter alias. Kept terse on purpose — these strings land verbatim in the
// completion scripts a user reads.
const FLAG = {
  dir: { desc: 'Target project root', arg: 'dir', short: 'd' },
  project: { desc: 'Install/act for this project only' },
  global: { desc: 'Install/act for every project (~/.claude)' },
  endpoint: { desc: 'Remote endpoint override', arg: 'url', short: 'e' },
  token: { desc: 'Remote token override', arg: 'token', short: 't' },
  mode: { desc: 'Override the resolved mode', arg: 'mode', values: ['off', 'local', 'remote'] },
  store: { desc: 'Local project-tier store directory', arg: 'dir' },
  from: { desc: 'Source store / range start', arg: 'path' },
  to: { desc: 'Destination / range end', arg: 'dest' },
  apply: { desc: 'Apply the migration (alias of --yes)' },
  yes: { desc: 'Non-interactive; never prompt', short: 'y' },
  hooks: { desc: 'Lifecycle hooks to wire', arg: 'mode', values: ['all', 'read-only', 'none'] },
  'no-hooks': { desc: 'Skip wiring the lifecycle hooks' },
  'mcp-json': { desc: 'Also write a committable project .mcp.json' },
  completions: { desc: 'Install shell completion', arg: 'shell', values: ['auto', 'zsh', 'fish', 'none'] },
  force: { desc: 'Overwrite / hard-delete' },
  deep: { desc: 'Do a write→read→delete round-trip' },
  telemetry: { desc: 'Verify the OTLP export credential works' },
  json: { desc: 'Machine-readable output' },
  scope: { desc: 'Restrict to / name a scope', arg: 'scope', complete: 'scope' },
  key: { desc: 'Name the key explicitly', arg: 'key' },
  threshold: { desc: 'Duplicate-similarity cutoff (0..1)', arg: 'n' },
  'cluster-by-key': { desc: 'Cluster by shared key capture', arg: 'regex' },
  value: { desc: 'Memory value', arg: 'text' },
  tags: { desc: 'Comma-separated tags', arg: 'a,b,c' },
  'source-agent': { desc: 'Source agent name to record', arg: 'name' },
  trigger: { desc: 'Trigger context slug', arg: 'slug' },
  'ttl-days': { desc: 'Days until auto-expiry (1..365)', arg: 'n' },
  'clear-ttl': { desc: 'Remove any existing expiry' },
  org: { desc: "Write to this org's scope (remote)", arg: 'slug' },
  'origin-repo': { desc: 'Override the provenance repository', arg: 'owner/name' },
  'origin-branch': { desc: 'Override the provenance branch', arg: 'branch' },
  'origin-commit': { desc: 'Override the provenance commit', arg: 'sha' },
  'origin-pr': { desc: 'The pull request this came out of', arg: 'n' },
  'no-origin': { desc: 'Record no provenance at all' },
  remote: { desc: 'Force the remote store' },
  local: { desc: 'Force the local offline store' },
  link: { desc: 'Print the dashboard deep-link URL instead' },
  base: { desc: 'Dashboard base URL for deep links', arg: 'url' },
  q: { desc: 'Pre-fill the Explorer search box', arg: 'text' },
  owner: { desc: 'Ownership filter', arg: 'owner' },
  range: { desc: 'Date range as JSON', arg: 'json' },
  archived: { desc: 'Include archived memories' },
  'retention-days': { desc: 'Only purge archived older than n days', arg: 'n' },
  files: { desc: 'Changed files to check', arg: 'path' },
  strict: { desc: 'Exit non-zero on any unmet obligation' },
  'strict-all': { desc: 'Exit non-zero on ANY unmet obligation, advisory included' },
  'min-seen-count': { desc: 'Minimum summed seen_count for a candidate', arg: 'n' },
  'policy-id': { desc: 'Run/preview a saved policy', arg: 'id' },
  'min-age-days': { desc: 'Match lessons at least n days old', arg: 'n' },
  'unseen-days': { desc: 'Match lessons unseen for at least n days', arg: 'n' },
  'max-seen-count': { desc: 'Match lessons that recurred at most n times', arg: 'n' },
  run: { desc: 'Archive the matches instead of previewing' },
  name: { desc: 'Policy name', arg: 'name' },
  enabled: { desc: 'Turn auto-mode on' },
  disabled: { desc: 'Turn auto-mode off' },
  'clear-min-age-days': { desc: 'Remove the min-age-days condition' },
  'clear-unseen-days': { desc: 'Remove the unseen-days condition' },
  'clear-max-seen-count': { desc: 'Remove the max-seen-count condition' },
  off: { desc: 'Unprotect instead of protect' },
};

// Every command's completion shape, in the top-level help order. `flags` lists
// the flag NAMES (keys of FLAG) a command accepts; `positional` names the kind
// of first positional argument, which drives dynamic value completion:
//   'address' → a `scope::key` (dynamic, from the local store)
//   'query'   → free text (no completion)
//   'shell'   → the `completion` command's zsh|fish argument
// `values` overrides a flag's static candidate list for this command only
// (migrate's `--to` is an enum here but a free date elsewhere).
const COMMANDS = [
  { name: 'install', summary: 'Scaffold skills, wire the MCP server, install hooks',
    flags: ['dir', 'project', 'global', 'endpoint', 'token', 'hooks', 'no-hooks', 'mcp-json', 'completions', 'force', 'yes'] },
  { name: 'uninstall', summary: 'Reverse install for the chosen scope',
    flags: ['dir', 'project', 'global', 'yes'] },
  { name: 'doctor', summary: 'Verify the install, connectivity, token, scope',
    flags: ['dir', 'mode', 'endpoint', 'token', 'store', 'deep', 'telemetry'] },
  { name: 'list', summary: 'List memories for the current directory', aliases: ['ls'],
    flags: ['dir', 'scope', 'json', 'endpoint', 'token', 'store', 'link', 'base'] },
  { name: 'search', summary: 'Full-text search the applicable memories', aliases: ['grep'],
    positional: 'query',
    flags: ['dir', 'scope', 'json', 'endpoint', 'token', 'store', 'link', 'base'] },
  { name: 'show', summary: 'Inspect one memory in full', positional: 'address',
    flags: ['dir', 'json', 'endpoint', 'token', 'store', 'scope', 'key', 'link', 'base'] },
  { name: 'stats', summary: 'Count memories per scope and store',
    flags: ['dir', 'scope', 'json', 'endpoint', 'token', 'store'] },
  { name: 'scopes', summary: 'Inventory every distinct scope',
    flags: ['dir', 'scope', 'json', 'endpoint', 'token', 'store'] },
  { name: 'diff', summary: 'Compare the offline and remote stores',
    flags: ['dir', 'scope', 'json', 'endpoint', 'token', 'store'] },
  { name: 'tree', summary: 'Show scope precedence and which memory wins', aliases: ['resolve'],
    flags: ['dir', 'scope', 'json', 'endpoint', 'token', 'store', 'link', 'base'] },
  { name: 'lint', summary: 'Flag low-quality memories (CI gate)',
    flags: ['dir', 'scope', 'json', 'endpoint', 'token', 'store'] },
  { name: 'dedupe', summary: 'Find likely-duplicate memories',
    flags: ['dir', 'scope', 'threshold', 'cluster-by-key', 'json', 'endpoint', 'token', 'store'] },
  { name: 'obligations', summary: 'Check changed files against the surface-partner map',
    positional: 'path',
    flags: ['files', 'strict', 'strict-all', 'json'] },
  { name: 'invariants', summary: "Compile pipeline's candidate scan (`invariants candidates`)",
    flags: ['dir', 'scope', 'min-seen-count', 'json', 'endpoint', 'token', 'store'] },
  { name: 'link', summary: 'Print a shareable dashboard deep-link URL', aliases: ['url'],
    positional: 'address',
    flags: ['dir', 'scope', 'key', 'q', 'owner', 'tags', 'range', 'from', 'to', 'archived', 'base', 'json'] },
  { name: 'migrate', summary: 'Relocate or push a local store',
    values: { to: ['home', 'project', 'remote'] },
    flags: ['dir', 'from', 'to', 'apply', 'yes'] },
  { name: 'bootstrap', summary: 'Apply the LoreKit schema to your own database',
    flags: ['yes', 'endpoint', 'token'] },
  { name: 'write', summary: 'Create or update a memory', positional: 'address',
    flags: ['dir', 'scope', 'key', 'value', 'tags', 'source-agent', 'trigger', 'ttl-days', 'clear-ttl',
      'org', 'origin-repo', 'origin-branch', 'origin-commit', 'origin-pr', 'no-origin', 'remote', 'local',
      'json', 'endpoint', 'token', 'store'] },
  { name: 'archive', summary: 'Hide a memory without losing it', positional: 'address',
    flags: ['scope', 'key', 'remote', 'local', 'json'] },
  { name: 'delete', summary: 'Archive a memory, or destroy it with --force', aliases: ['rm'],
    positional: 'address',
    flags: ['force', 'scope', 'key', 'remote', 'local', 'json'] },
  { name: 'restore', summary: 'Bring an archived memory back', positional: 'address',
    flags: ['scope', 'key', 'remote', 'local', 'json'] },
  { name: 'purge', summary: 'Delete archived memories past a retention window',
    flags: ['retention-days', 'yes', 'json', 'endpoint', 'token'] },
  { name: 'purge-expired', summary: 'Delete every TTL-expired memory',
    flags: ['yes', 'json', 'endpoint', 'token'] },
  { name: 'groom', summary: 'Preview or run a retention sweep',
    values: { mode: ['review', 'auto'] },
    flags: ['policy-id', 'scope', 'min-age-days', 'unseen-days', 'max-seen-count', 'run', 'yes', 'json', 'endpoint', 'token'] },
  { name: 'policy', summary: 'Manage saved retention rules',
    values: { mode: ['review', 'auto'] },
    flags: ['scope', 'name', 'mode', 'enabled', 'disabled', 'min-age-days', 'unseen-days', 'max-seen-count',
      'clear-min-age-days', 'clear-unseen-days', 'clear-max-seen-count', 'yes', 'json', 'endpoint', 'token'] },
  { name: 'protect', summary: 'Mark a memory protected, excluded from every grooming sweep', positional: 'address',
    flags: ['off', 'scope', 'key', 'json', 'endpoint', 'token'] },
  { name: 'pin', summary: 'Shorthand for `protect` (protected=true)', positional: 'address',
    flags: ['json', 'endpoint', 'token'] },
  { name: 'unpin', summary: 'Shorthand for `protect --off` (protected=false)', positional: 'address',
    flags: ['json', 'endpoint', 'token'] },
  { name: 'completion', summary: 'Print a shell completion script', positional: 'shell' },
];

// The completion spec, resolved to concrete flag metadata. Exported so the
// renderers and the parity test read the SAME structure.
export function completionSpec() {
  return COMMANDS.map((cmd) => ({
    name: cmd.name,
    summary: cmd.summary,
    aliases: cmd.aliases ?? [],
    positional: cmd.positional ?? null,
    flags: (cmd.flags ?? []).map((flagName) => {
      const meta = FLAG[flagName];
      if (!meta) throw new Error(`completionSpec: command ${cmd.name} references unknown flag ${flagName}`);
      const values = cmd.values?.[flagName] ?? meta.values ?? null;
      return { name: flagName, ...meta, values };
    }),
  }));
}

// Every command word a completion offers — canonical names AND their aliases —
// so `lorekit l<TAB>` surfaces both `list` and `ls`. Aliases inherit the
// canonical command's summary.
function commandWords(spec) {
  const words = [];
  for (const cmd of spec) {
    words.push({ word: cmd.name, summary: cmd.summary });
    for (const alias of cmd.aliases) words.push({ word: alias, summary: cmd.summary });
  }
  return words;
}

// Every alias-or-name that dispatches to one command, for the per-command
// `case` arm (zsh) / `__fish_seen_subcommand_from` set (fish).
const cmdWordSet = (cmd) => [cmd.name, ...cmd.aliases];

// --- zsh -------------------------------------------------------------------

// zsh optspec for one flag: `'(-x --name)'{-x,--name}'[desc]:arg:action'` when a
// short alias exists, else `'--name[desc]:arg:action'`. A boolean flag omits the
// `:arg:action` tail.
function zshFlag(flag) {
  const desc = zshDesc(flag.desc);
  const tail = flag.arg ? `:${flag.arg}:${zshAction(flag)}` : '';
  if (flag.short) {
    return `'(-${flag.short} --${flag.name})'{-${flag.short},--${flag.name}}'[${desc}]${tail}'`;
  }
  return `'--${flag.name}[${desc}]${tail}'`;
}

// The zsh completion ACTION for a flag's value: a dynamic helper, a static
// `(a b c)` list, file/dir completion, or nothing.
function zshAction(flag) {
  if (flag.complete === 'scope') return '_lorekit_scopes';
  if (flag.values) return `(${flag.values.join(' ')})`;
  if (flag.arg === 'dir') return '_files -/';
  if (flag.arg === 'path' || flag.arg === 'file') return '_files';
  return ' ';
}

// The zsh positional-argument spec for a command, or '' when it takes none.
function zshPositional(kind) {
  if (kind === 'address') return `'*::address:_lorekit_addresses'`;
  if (kind === 'query') return `'*::query: '`;
  if (kind === 'path') return `'*::file:_files'`;
  if (kind === 'shell') return `'1:shell:(${COMPLETION_SHELLS.join(' ')})'`;
  return '';
}

// zsh escaping: the description sits inside a single-quoted `[...]`, so a literal
// single quote is doubled and a `[`/`]`/`:` is backslash-escaped (they are
// optspec metacharacters). Our descriptions avoid these, but escaping keeps a
// future edit from producing a script that fails to source.
function zshDesc(s) {
  return String(s).replace(/'/g, "''").replace(/[\][:]/g, '\\$&');
}

function renderZsh(spec) {
  const commands = commandWords(spec)
    .map((c) => `    '${c.word}:${zshDesc(c.summary)}'`)
    .join('\n');

  const arms = spec
    .map((cmd) => {
      const specs = [zshPositional(cmd.positional), ...cmd.flags.map(zshFlag)].filter(Boolean);
      const body = specs.length ? `_arguments \\\n        ${specs.join(' \\\n        ')}` : ':';
      return `    ${cmdWordSet(cmd).join('|')})\n      ${body}\n      ;;`;
    })
    .join('\n');

  return `#compdef lorekit
# LoreKit CLI completion for zsh — generated by \`lorekit completion zsh\`.
# Regenerate after upgrading the CLI. See \`lorekit completion --help\`.

_lorekit() {
  local -a _lk_commands
  _lk_commands=(
${commands}
  )

  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C '1:command:->cmds' '*::arg:->args' && return 0

  case $state in
    cmds)
      _describe -t commands 'lorekit command' _lk_commands
      ;;
    args)
      case $line[1] in
${arms}
      esac
      ;;
  esac
}

# Dynamic candidates come from the CLI itself, so they always reflect the local
# store. Failures are swallowed — a missing token or store just yields no
# candidates, never an error at the prompt.
_lorekit_scopes() {
  local -a _lk_scopes
  _lk_scopes=(\${(f)"$(lorekit completion --complete scope 2>/dev/null)"})
  compadd -a _lk_scopes
}

_lorekit_addresses() {
  local -a _lk_addr
  _lk_addr=(\${(f)"$(lorekit completion --complete key 2>/dev/null)"})
  compadd -a _lk_addr
}

compdef _lorekit lorekit
`;
}

// --- fish ------------------------------------------------------------------

// fish description escaping: the value sits in a single-quoted `-d '...'`, so a
// single quote and a backslash are backslash-escaped.
function fishDesc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// One `complete` line for a flag under a command guard.
function fishFlag(guard, flag) {
  const parts = ['complete', '-c', 'lorekit', '-n', `'${guard}'`, '-l', flag.name];
  if (flag.short) parts.push('-s', flag.short);
  if (flag.arg) parts.push('-r'); // requires a value
  if (flag.complete === 'scope') parts.push('-f', '-a', "'(lorekit completion --complete scope)'");
  else if (flag.values) parts.push('-a', `'${flag.values.join(' ')}'`);
  parts.push('-d', `'${fishDesc(flag.desc)}'`);
  return parts.join(' ');
}

function fishPositional(guard, kind) {
  if (kind === 'address') {
    return `complete -c lorekit -n '${guard}' -f -a '(lorekit completion --complete key)'`;
  }
  if (kind === 'path') {
    // Re-enable the file completion the global `complete -c lorekit -f` turned off.
    return `complete -c lorekit -n '${guard}' -F`;
  }
  if (kind === 'shell') {
    return `complete -c lorekit -n '${guard}' -f -a '${COMPLETION_SHELLS.join(' ')}'`;
  }
  return null;
}

function renderFish(spec) {
  const lines = [
    '# LoreKit CLI completion for fish — generated by `lorekit completion fish`.',
    '# Install to ~/.config/fish/completions/lorekit.fish (fish auto-loads it).',
    '',
    '# Disable file completion by default; commands opt back in where it helps.',
    'complete -c lorekit -f',
    '',
    '# Subcommands (offered only before one is chosen).',
  ];

  for (const cmd of commandWords(spec)) {
    lines.push(
      `complete -c lorekit -n __fish_use_subcommand -a ${cmd.word} -d '${fishDesc(cmd.summary)}'`,
    );
  }

  for (const cmd of spec) {
    const guard = `__fish_seen_subcommand_from ${cmdWordSet(cmd).join(' ')}`;
    lines.push('', `# ${cmd.name}`);
    const positional = fishPositional(guard, cmd.positional);
    if (positional) lines.push(positional);
    for (const flag of cmd.flags) lines.push(fishFlag(guard, flag));
  }

  return lines.join('\n') + '\n';
}

// Render the completion script for a shell. Throws on an unknown shell so a
// caller (or a typo) fails loudly rather than writing an empty file.
export function renderCompletion(shell, spec = completionSpec()) {
  if (shell === 'zsh') return renderZsh(spec);
  if (shell === 'fish') return renderFish(spec);
  throw new Error(`Unsupported shell: ${shell}. Supported: ${COMPLETION_SHELLS.join(', ')}`);
}

// --- shell detection + on-disk install/teardown ----------------------------

// The shell a bare `--completions auto` targets, from $SHELL. Returns a
// supported shell name or null (unknown / unsupported), so the caller can say so
// rather than guessing.
export function detectShell(env = process.env) {
  const shellPath = env.SHELL || '';
  const base = path.basename(shellPath);
  return COMPLETION_SHELLS.includes(base) ? base : null;
}

// The zsh block appended to ~/.zshrc, wrapped in idempotent guard markers so
// re-running install never duplicates it and uninstall can remove exactly it.
// zsh — unlike fish — has no universal auto-load directory, so the file lives in
// a LoreKit-owned dir that this block adds to $fpath before compinit.
const ZSH_MARK_START = '# >>> lorekit completions >>>';
const ZSH_MARK_END = '# <<< lorekit completions <<<';

function zshBlock(dir) {
  return [
    ZSH_MARK_START,
    '# Added by `lorekit install`. Managed block — edits here are overwritten.',
    `fpath=("${dir}" $fpath)`,
    'autoload -Uz compinit && compinit',
    ZSH_MARK_END,
  ].join('\n');
}

// Where each shell's completion artefacts live. `file` is the script; `rcFile`
// (+ the guard block) is only used for shells with no auto-load directory.
//   zsh  → ~/.lorekit/completions/_lorekit, sourced via an ~/.zshrc fpath block
//   fish → ~/.config/fish/completions/lorekit.fish (fish auto-loads the dir)
export function completionTargets(shell, home = homeDir()) {
  if (shell === 'zsh') {
    const dir = path.join(home, '.lorekit', 'completions');
    return {
      shell,
      dir,
      file: path.join(dir, '_lorekit'),
      rcFile: path.join(home, '.zshrc'),
      autoloaded: false,
    };
  }
  if (shell === 'fish') {
    const dir = path.join(home, '.config', 'fish', 'completions');
    return { shell, dir, file: path.join(dir, 'lorekit.fish'), rcFile: null, autoloaded: true };
  }
  throw new Error(`Unsupported shell: ${shell}. Supported: ${COMPLETION_SHELLS.join(', ')}`);
}

// Splice the guarded zsh block into rc text: replace an existing block in place
// (so a stale fpath dir is corrected), else append it. Pure, so the idempotency
// is unit-testable without touching a real ~/.zshrc.
export function upsertGuardedBlock(rcText, block) {
  const text = rcText || '';
  const start = text.indexOf(ZSH_MARK_START);
  if (start === -1) {
    const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    return { text: `${text}${sep}${block}\n`, changed: text.indexOf(block) === -1 };
  }
  const end = text.indexOf(ZSH_MARK_END, start);
  if (end === -1) {
    // A start marker with no end — treat the rest of the file as the block.
    return { text: text.slice(0, start) + block + '\n', changed: true };
  }
  const before = text.slice(0, start);
  const after = text.slice(end + ZSH_MARK_END.length).replace(/^\n/, '');
  const next = `${before}${block}\n${after}`;
  return { text: next, changed: next !== text };
}

// Remove the guarded zsh block from rc text (uninstall). Pure inverse of
// `upsertGuardedBlock`; a no-op when no block is present.
export function removeGuardedBlock(rcText) {
  const text = rcText || '';
  const start = text.indexOf(ZSH_MARK_START);
  if (start === -1) return { text, changed: false };
  const end = text.indexOf(ZSH_MARK_END, start);
  const cut = end === -1 ? text.length : end + ZSH_MARK_END.length;
  const before = text.slice(0, start).replace(/\n$/, '');
  const after = text.slice(cut).replace(/^\n/, '');
  const next = [before, after].filter(Boolean).join('\n') + (before || after ? '\n' : '');
  return { text: next, changed: true };
}

// Write the completion script to disk for `shell`, wiring the ~/.zshrc block
// when the shell has no auto-load directory. Returns what happened so `install`
// can report it. `home` is injectable for tests.
export function installCompletion(shell, { home = homeDir() } = {}) {
  const targets = completionTargets(shell, home);
  const script = renderCompletion(shell);
  fs.mkdirSync(targets.dir, { recursive: true });
  writeFileAtomic(targets.file, script);

  let rcUpdated = false;
  if (targets.rcFile) {
    const existing = fs.existsSync(targets.rcFile) ? fs.readFileSync(targets.rcFile, 'utf8') : '';
    const { text, changed } = upsertGuardedBlock(existing, zshBlock(targets.dir));
    if (changed) {
      writeFileAtomic(targets.rcFile, text);
      rcUpdated = true;
    }
  }

  return { shell, file: targets.file, rcFile: targets.rcFile, autoloaded: targets.autoloaded, rcUpdated };
}

// Remove the completion script and any ~/.zshrc block for `shell`. Best-effort
// and idempotent — a missing file / block is reported as `removed: false`, never
// an error. `uninstall` calls this for every supported shell.
export function removeCompletion(shell, { home = homeDir() } = {}) {
  const targets = completionTargets(shell, home);
  let removed = false;
  if (fs.existsSync(targets.file)) {
    fs.rmSync(targets.file, { force: true });
    removed = true;
  }
  let rcUpdated = false;
  if (targets.rcFile && fs.existsSync(targets.rcFile)) {
    const existing = fs.readFileSync(targets.rcFile, 'utf8');
    const { text, changed } = removeGuardedBlock(existing);
    if (changed) {
      writeFileAtomic(targets.rcFile, text);
      rcUpdated = true;
    }
  }
  // `removed` reports whether ANYTHING was torn down (the script file or the rc
  // block), so a caller's "nothing to remove" line is honest even in the rare
  // case where only the block survived a manually-deleted file.
  return { shell, file: targets.file, removed: removed || rcUpdated, fileRemoved: removed, rcUpdated };
}
