// Tiny zero-dependency console helpers. No colors when not a TTY (CI-friendly).
import process from 'node:process';

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const wrap = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
};

export const sym = {
  pass: useColor ? c.green('✓') : 'PASS',
  fail: useColor ? c.red('✗') : 'FAIL',
  warn: useColor ? c.yellow('!') : 'WARN',
  info: useColor ? c.cyan('•') : '-',
};

export function log(msg = '') {
  process.stdout.write(`${msg}\n`);
}

export function err(msg = '') {
  process.stderr.write(`${msg}\n`);
}

export function heading(title) {
  log(`\n${c.bold(title)}`);
}

// A single doctor-style status line.
export function status(kind, label, detail) {
  const mark = sym[kind] ?? sym.info;
  const tail = detail ? ` ${c.dim('— ' + detail)}` : '';
  log(`  ${mark} ${label}${tail}`);
}

// Map a raw keypress to a select-list action. Pure so it can be unit-tested
// without a pseudo-TTY. Supports arrow keys (both the `ESC [` and application
// `ESC O` cursor modes) and vim-style j/k.
export function selectAction(key) {
  if (key === '') return 'cancel'; // Ctrl-C
  if (key === '\r' || key === '\n') return 'submit';
  if (key === 'k' || (key.startsWith('') && key.endsWith('A'))) return 'up';
  if (key === 'j' || (key.startsWith('') && key.endsWith('B'))) return 'down';
  return null;
}

// Interactive single-choice list. `options` is [{ label, value, hint? }].
// Arrow keys / j / k move, Enter selects, Ctrl-C aborts. Falls back to the
// default option when stdin isn't a TTY (CI / piped input), matching the
// non-interactive install path. Zero-dependency; renders with raw ANSI.
export function select(question, options, { defaultIndex = 0 } = {}) {
  const { stdin, stdout } = process;
  let index = Math.max(0, Math.min(defaultIndex, options.length - 1));

  if (!stdin.isTTY) return Promise.resolve(options[index].value);

  return new Promise((resolve) => {
    const render = (first) => {
      if (!first) stdout.write(`[${options.length}A`); // cursor up N lines
      for (let i = 0; i < options.length; i++) {
        const active = i === index;
        const pointer = active ? c.cyan('❯') : ' ';
        const label = active ? c.cyan(options[i].label) : options[i].label;
        const hint = options[i].hint ? ` ${c.dim('— ' + options[i].hint)}` : '';
        stdout.write(`[2K  ${pointer} ${label}${hint}\n`); // clear line, write
      }
    };

    log(`  ${question}`);
    stdout.write('[?25l'); // hide cursor
    render(true);

    const prevRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.setRawMode(prevRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('[?25h'); // show cursor
    };

    const onData = (key) => {
      switch (selectAction(key)) {
        case 'cancel':
          cleanup();
          stdout.write('\n');
          process.exit(130);
          break;
        case 'up':
          index = (index - 1 + options.length) % options.length;
          render(false);
          break;
        case 'down':
          index = (index + 1) % options.length;
          render(false);
          break;
        case 'submit':
          cleanup();
          resolve(options[index].value);
          break;
        default:
          break;
      }
    };

    stdin.on('data', onData);
  });
}

// Minimal flag parser: --key value, --key=value, -k value, and bare --flags.
// `aliases` maps short → long; `booleans` lists flags that take no value.
// When `known` is a non-null list of long flag names, any flag whose resolved
// name isn't in it is collected (as its original token) into `out._unknown` —
// letting the caller reject typos like `--gloabl` instead of silently ignoring
// them. `out._unknown` is only present when `known` was supplied.
export function parseArgs(argv, { aliases = {}, booleans = [], known = null } = {}) {
  const out = { _: [] };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    if (!token.startsWith('-')) {
      out._.push(token);
      continue;
    }
    let value;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      value = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    let key = token.replace(/^-+/, '');
    if (aliases[key]) key = aliases[key];
    if (known && !known.includes(key)) unknown.push(token);
    if (booleans.includes(key)) {
      out[key] = true;
      continue;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        value = next;
        i++;
      } else {
        value = true; // treat as boolean-ish when no value follows
      }
    }
    out[key] = value;
  }
  if (known) out._unknown = unknown;
  return out;
}
