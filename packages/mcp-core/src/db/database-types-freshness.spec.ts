import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * `supabase/functions/_shared/database.types.ts` is GENERATED from the live
 * schema by `pnpm nx db:types supabase`, and it is committed. That combination
 * has exactly one failure mode: a migration adds a table and nobody
 * regenerates, so the committed types describe a schema that no longer exists.
 *
 * It had already happened. `blog_post_likes` shipped in migration 00055 and was
 * absent from the types, which meant `db.from('blog_post_likes')` did not
 * typecheck at all once the client was given its `Database` generic — and
 * before that, when the client was untyped, it silently resolved to `never`
 * along with every other table. Nothing failed either way, because nothing
 * compared the two.
 *
 * This compares them. It is deliberately a NAME-level check, not a column-level
 * one: parsing every column's SQL type out of the migrations would be a second,
 * worse implementation of the generator, and the generator is the thing we want
 * people to run. A missing table is the failure that actually occurs, and it is
 * the one a name check catches.
 *
 * When this goes red the fix is `pnpm nx db:types supabase` — not an edit to
 * the generated file.
 */

const repoRoot = path.join(import.meta.dirname, '../../../..');
const migrationsDir = path.join(repoRoot, 'supabase/migrations');
const typesFile = path.join(repoRoot, 'supabase/functions/_shared/database.types.ts');

/** Table names created by any migration. */
function tablesInMigrations(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const m of sql.matchAll(/create table(?: if not exists)?\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      found.add(m[1] as string);
    }
  }
  return found;
}

/** Table names declared under `public.Tables` in the generated types. */
function tablesInGeneratedTypes(): Set<string> {
  const src = readFileSync(typesFile, 'utf8');
  // The generator emits each table at exactly six spaces of indentation inside
  // `public: { Tables: { … } }`. Anchored on that depth so `Row`/`Insert` keys
  // (eight spaces) and the `Views`/`Functions` sections do not match.
  return new Set([...src.matchAll(/^ {6}([a-z_][a-z0-9_]*): \{$/gm)].map((m) => m[1] as string));
}

describe('generated database types are in step with the migrations', () => {
  it('finds tables on both sides (guards the two parsers against matching nothing)', () => {
    // Without this, a regex that stopped matching would compare two empty sets
    // and pass — the exact shape of vacuous gate this repo keeps tripping over.
    expect(tablesInMigrations().size).toBeGreaterThanOrEqual(15);
    expect(tablesInGeneratedTypes().size).toBeGreaterThanOrEqual(50);
  });

  it('declares every table a migration creates', () => {
    const missing = [...tablesInMigrations()].filter((t) => !tablesInGeneratedTypes().has(t)).sort();
    expect(
      missing,
      `database.types.ts is stale — these tables exist in migrations but not in the types:\n  ${missing.join('\n  ')}\n`
      + 'Regenerate with `pnpm nx db:types supabase`; do not hand-edit the generated file.',
    ).toEqual([]);
  });
});
