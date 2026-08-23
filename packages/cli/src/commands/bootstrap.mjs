// `lorekit bootstrap` — apply the BYOD schema to a user-supplied Supabase database.
//
// Reads LOREKIT_STORAGE_URL and LOREKIT_STORAGE_SERVICE_KEY from the environment.
// If neither is set, prints a helpful message and exits 0 — bootstrap is only
// needed for BYOD (Bring Your Own Database) setups.
//
// Because Supabase's JS client does not expose a raw SQL execution method for DDL,
// this command instructs the user to run the SQL file directly with psql when no
// direct execution path is available. It validates connectivity using the anon key
// and confirms the bootstrap.sql path for the user.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { log, err, heading, status, c } from '../shared/util.mjs';

// The bootstrap.sql file is at <repo-root>/supabase/byod/bootstrap.sql.
// This file lives at packages/cli/src/commands/bootstrap.mjs, so the relative
// path from here to the repo root is ../../../../  (commands → src → cli →
// packages → root).
const BOOTSTRAP_SQL_PATH = fileURLToPath(
  new URL('../../../../supabase/byod/bootstrap.sql', import.meta.url),
);

export async function bootstrap(_args) {
  heading('LoreKit bootstrap');

  const storageUrl = process.env['LOREKIT_STORAGE_URL'];
  const storageServiceKey = process.env['LOREKIT_STORAGE_SERVICE_KEY'];
  const storageAnonKey = process.env['LOREKIT_STORAGE_ANON_KEY'];

  // If no BYOD env vars are set, this command is a no-op — it's only for BYOD.
  if (!storageUrl && !storageServiceKey) {
    log('');
    log(
      `  ${c.cyan('•')} No BYOD storage configured — ${c.dim('bootstrap is only needed for custom databases.')}`,
    );
    log('');
    log('  Set LOREKIT_STORAGE_URL and LOREKIT_STORAGE_SERVICE_KEY to use your own');
    log('  Supabase project, then re-run this command.');
    log('');
    log('  See docs/byod.md for setup instructions.');
    return 0;
  }

  if (!storageUrl) {
    err(`${c.red('Error:')} LOREKIT_STORAGE_SERVICE_KEY is set but LOREKIT_STORAGE_URL is missing.`);
    err('  Both variables are required. Set LOREKIT_STORAGE_URL and try again.');
    return 1;
  }

  // Locate the bootstrap SQL file.
  let sqlPath = BOOTSTRAP_SQL_PATH;

  // When running from a published npm package, the SQL file is not bundled
  // with the CLI. Fall back to looking for it relative to CWD (for dev use).
  if (!fs.existsSync(sqlPath)) {
    const cwdPath = path.resolve(process.cwd(), 'supabase/byod/bootstrap.sql');
    if (fs.existsSync(cwdPath)) {
      sqlPath = cwdPath;
    } else {
      err(`${c.red('Error:')} bootstrap.sql not found at expected path:`);
      err(`  ${sqlPath}`);
      err('');
      err('  Apply the schema manually with psql:');
      err('    psql "$DATABASE_URL" -f supabase/byod/bootstrap.sql');
      err('');
      err('  Or download it from the LoreKit repository:');
      err('    https://github.com/mthines/lorekit/blob/main/supabase/byod/bootstrap.sql');
      return 1;
    }
  }

  status('pass', 'bootstrap.sql', sqlPath);
  status('info', 'storage url', storageUrl);

  // Test connectivity using the anon key if available (non-DDL path).
  if (storageAnonKey) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const db = createClient(storageUrl, storageAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // Simple ping: list memories (will return 0 rows or error if schema not applied yet).
      const { error } = await db.from('memories').select('id').limit(1);
      if (error && error.code === '42P01') {
        // Table does not exist yet — that's expected before bootstrap.
        status('info', 'connectivity', 'connected — schema not yet applied (run bootstrap)');
      } else if (error) {
        status('warn', 'connectivity', `connected but got: ${error.message}`);
      } else {
        status('pass', 'connectivity', 'connected and schema already present');
      }
    } catch (e) {
      status('warn', 'connectivity', `could not verify: ${e && e.message ? e.message : String(e)}`);
    }
  } else {
    status('info', 'connectivity', 'skipped — LOREKIT_STORAGE_ANON_KEY not set');
  }

  // Supabase JS client cannot execute raw DDL SQL directly.
  // The correct path is psql or the Supabase dashboard SQL editor.
  log('');
  log(`  ${c.bold('To apply the schema, run:')}`);
  log('');
  log(`    ${c.cyan('psql "$DATABASE_URL" -f')} ${sqlPath}`);
  log('');
  log(`  Or paste the contents of ${c.dim(sqlPath)}`);
  log('  into the Supabase dashboard → SQL Editor.');
  log('');

  if (storageServiceKey) {
    status(
      'info',
      'service key',
      'LOREKIT_STORAGE_SERVICE_KEY is set — use it as $DATABASE_URL password with psql',
    );
    log('');
    log(`  ${c.dim('Example:')}`);
    log(
      `    ${c.cyan('DATABASE_URL')}="postgresql://postgres.${parseRef(storageUrl)}:${storageServiceKey}@aws-0-us-east-1.pooler.supabase.com:6543/postgres"`,
    );
    log(`    ${c.cyan('psql "$DATABASE_URL"')} -f ${sqlPath}`);
    log('');
    log(
      `  ${c.dim('(Replace the host/port above with the exact connection string from your')}`,
    );
    log(`  ${c.dim('Supabase dashboard → Settings → Database → Connection string.)')}`);
  }

  return 0;
}

// Extract the project ref from a Supabase URL for display in the example.
function parseRef(url) {
  try {
    const host = new URL(url).hostname; // e.g. abcdefgh.supabase.co
    return host.split('.')[0];
  } catch {
    return '<project-ref>';
  }
}
