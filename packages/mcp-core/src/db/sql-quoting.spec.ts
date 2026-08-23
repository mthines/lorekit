import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findQuotingIssues } from './sql-quoting.js';

/**
 * Structural guard: every `.sql` file in the repository has balanced quoting.
 *
 * This lives here, alongside the other source-scan guards (`edge-parity`,
 * `edge-bare-specifier`, `audit-vocabulary`), for the same reason they do:
 * there is no test harness on the SQL side, so a vitest suite in mcp-core is
 * the only place a rule about those files can actually fail a PR.
 *
 * The concrete regression: a migration whose repo CHECK ended in `…+$'` and a
 * `do $$` block in the SQL test suite were both mangled by a
 * `String.prototype.replace` whose replacement text contained `$'` and `$$`.
 * Every TypeScript gate stayed green — SQL is never compiled — and the failure
 * surfaced only when `supabase start` refused to apply the migration, with an
 * error naming neither the file nor the line.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const SQL_ROOTS = ['supabase/migrations', 'supabase/tests'];

/** Every `.sql` file under `target`, recursively. */
function collectSqlFiles(target: string): string[] {
  if (statSync(target).isFile()) return target.endsWith('.sql') ? [target] : [];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) =>
    collectSqlFiles(path.join(target, entry.name)),
  );
}

const sqlFiles = SQL_ROOTS.flatMap((root) => collectSqlFiles(path.join(repoRoot, root))).sort();

describe('SQL quoting guard — repository scan', () => {
  // Anti-vacuity floor: if the roots move or a glob breaks, the scan below
  // would pass by finding nothing. The repo has well over 40 migrations.
  it('finds the SQL tree', () => {
    expect(sqlFiles.length).toBeGreaterThan(40);
  });

  it.each(sqlFiles.map((f) => [path.relative(repoRoot, f), f]))(
    '%s has balanced quoting',
    (_label, file) => {
      expect(findQuotingIssues(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );
});

describe('findQuotingIssues', () => {
  it('accepts a balanced dollar-quoted function body', () => {
    const sql = ['create function f() returns void language plpgsql as $$', 'begin', '  perform 1;', 'end;', '$$;'].join('\n');
    expect(findQuotingIssues(sql)).toEqual([]);
  });

  it('accepts a tagged dollar quote', () => {
    expect(findQuotingIssues("select $tag$ body with 'quotes' $tag$;")).toEqual([]);
  });

  it('accepts a regex literal containing $ anchors', () => {
    const sql = "alter table t add constraint c check (col ~ '^[a-z]+$' and col !~ '(^|/)\\.+(/|$)');";
    expect(findQuotingIssues(sql)).toEqual([]);
  });

  it('accepts the SQL escaped-quote form', () => {
    expect(findQuotingIssues("select 'it''s fine';")).toEqual([]);
  });

  it('ignores quotes inside a line comment', () => {
    expect(findQuotingIssues("-- it's only a comment\nselect 1;")).toEqual([]);
  });

  it('ignores quotes inside a block comment', () => {
    expect(findQuotingIssues("/* it's $$ only a comment */\nselect 1;")).toEqual([]);
  });

  it('does not flag a positional parameter', () => {
    expect(findQuotingIssues('select * from t where id = $1;')).toEqual([]);
  });

  it("flags a truncated string literal — the `$'` replacement bug", () => {
    const issues = findQuotingIssues("alter table t add constraint c check (col ~ '^[a-z]+\nselect 1;");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/unterminated ' string literal/);
  });

  it('flags a collapsed `do $` — the `$$` replacement bug', () => {
    const issues = findQuotingIssues('do $\nbegin\nend;\n$$;\n');
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]?.message).toMatch(/lone `\$`/);
  });

  it('flags an unterminated dollar-quoted body', () => {
    const issues = findQuotingIssues('do $$\nbegin\n  perform 1;\nend;\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/unterminated \$\$ dollar-quoted string/);
  });

  it('reports the line of the opening quote, not the end of the file', () => {
    expect(findQuotingIssues("select 1;\nselect 2;\nselect 'unclosed\n")[0]?.line).toBe(3);
  });
});

describe('findQuotingIssues — double-quoted identifiers', () => {
  it("does not let a ' inside a quoted identifier open a phantom literal", () => {
    // Without a double-quote state the apostrophe below would open a string
    // that swallows the rest of the file and desyncs every later quote.
    expect(findQuotingIssues(`select "it's a column" from t where x = 'v';`)).toEqual([]);
  });

  it('accepts the doubled-quote escape inside an identifier', () => {
    expect(findQuotingIssues('select "a""b" from t;')).toEqual([]);
  });

  it('flags an unterminated quoted identifier', () => {
    const issues = findQuotingIssues('select "unclosed from t;\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/unterminated " quoted identifier/);
  });
});

describe('findQuotingIssues — escape-string syntax', () => {
  it("treats a backslash-escaped quote inside E'…' as escaped, not a terminator", () => {
    // A phantom finding here would be worse than a missed one: the scan stops
    // at the first issue, so it would mask every real finding after it.
    expect(findQuotingIssues("select E'it\\'s ok';")).toEqual([]);
  });

  it('handles an escaped backslash at the end of an escape string', () => {
    expect(findQuotingIssues("select E'trailing\\\\';")).toEqual([]);
  });

  it('accepts a lowercase e prefix', () => {
    expect(findQuotingIssues("select e'it\\'s ok';")).toEqual([]);
  });

  it('does not treat a backslash as an escape in an ordinary literal', () => {
    // Without the E prefix the backslash is just a character, and the quote
    // that follows it really does terminate the string.
    expect(findQuotingIssues("select 'a\\', 'b';")).toEqual([]);
  });

  it('does not mistake an identifier ending in e for an escape-string prefix', () => {
    expect(findQuotingIssues("select value'x';")).toEqual([]);
  });

  it('still flags an unterminated escape string', () => {
    const issues = findQuotingIssues("select E'unclosed\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/unterminated ' string literal/);
  });
});
