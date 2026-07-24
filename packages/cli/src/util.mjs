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

// Minimal flag parser: --key value, --key=value, -k value, and bare --flags.
// `aliases` maps short → long; `booleans` lists flags that take no value.
export function parseArgs(argv, { aliases = {}, booleans = [] } = {}) {
  const out = { _: [] };
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
  return out;
}
