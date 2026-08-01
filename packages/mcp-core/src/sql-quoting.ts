// Pure SQL quote-balance lexer.
//
// Why this exists: a `$$` function body or a `$`-bearing regex literal is
// trivially corrupted by tooling that treats `$` as a substitution character.
// JavaScript's `String.prototype.replace` reads `$$` as an escaped `$` and
// `$'` as "the text after the match"; `sed` and shell expansion have their own
// rules. The damage is quiet: one `do $` instead of `do $$`, or a string
// literal that silently loses its closing quote and swallows the rest of the
// file.
//
// Nothing else in this repository would catch it. SQL is never compiled, so
// `typecheck`, `test` and `lint` are all green on a migration that cannot
// parse, and the first symptom is `supabase start` failing in the integration
// job with a bare `syntax error at or near "("` that names neither the file nor
// the line.
//
// This is deliberately a LEXER, not a parser: zero dependencies, and it makes
// no claim about whether the SQL is semantically valid. It answers one
// question — is every quote closed? — which is exactly the failure mode those
// substitution bugs produce.

export interface QuotingIssue {
  /** 1-based line of the quote that was never closed. */
  line: number;
  message: string;
}

/** If a dollar quote opens at `index`, its full tag (`$$`, `$tag$`), else null. */
function readDollarTag(text: string, index: number): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(index));
  return match ? match[0] : null;
}

/**
 * Scan SQL text for unbalanced quoting.
 *
 * Recognises, in the order the Postgres scanner does:
 *   - `--` line comments and block comments (quotes inside are inert)
 *   - single-quoted string literals, including the `''` escape
 *   - dollar-quoted strings with an optional tag: `$$ … $$`, `$tag$ … $tag$`
 *
 * Stops at the first unterminated construct: everything after it is, by
 * definition, being read in the wrong lexical state, so further findings would
 * be noise.
 */
export function findQuotingIssues(text: string): QuotingIssue[] {
  const findings: QuotingIssue[] = [];
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;

  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);

    if (two === '--') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }

    if (two === '/*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) {
        findings.push({ line: lineOf(i), message: 'unterminated block comment' });
        break;
      }
      i = close + 2;
      continue;
    }

    if (text[i] === "'") {
      const start = i;
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === "'") {
          // '' is an escaped quote, not a terminator.
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) {
        findings.push({ line: lineOf(start), message: "unterminated ' string literal" });
        break;
      }
      continue;
    }

    if (text[i] === '$') {
      const tag = readDollarTag(text, i);
      if (tag === null) {
        // A bare `$` that opens no dollar quote. Legal in some contexts (`$1`
        // parameters), so only the classic collapsed `do $` / `$;` shape a
        // substitution produces is reported.
        if (/^\$(;|\s|$)/.test(text.slice(i, i + 2))) {
          findings.push({
            line: lineOf(i),
            message: 'lone `$` where a `$$` dollar quote was expected (collapsed by a substitution?)',
          });
        }
        i += 1;
        continue;
      }
      const close = text.indexOf(tag, i + tag.length);
      if (close === -1) {
        findings.push({ line: lineOf(i), message: `unterminated ${tag} dollar-quoted string` });
        break;
      }
      i = close + tag.length;
      continue;
    }

    i += 1;
  }

  return findings;
}
