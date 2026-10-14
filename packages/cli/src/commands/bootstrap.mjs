// `lorekit bootstrap` — check a BYOD Supabase database and print how to apply
// the LoreKit schema to it.
//
// Reads LOREKIT_STORAGE_URL and LOREKIT_STORAGE_ANON_KEY / LOREKIT_STORAGE_SERVICE_KEY
// from the environment. If none is set, prints a helpful message and exits 0 —
// bootstrap is only needed for BYOD (Bring Your Own Database) setups.
//
// It does NOT apply the schema itself: PostgREST (the only thing a Supabase API
// key reaches) cannot run DDL. It probes the project, locates
// supabase/byod/bootstrap.sql (generated from the migrations), and prints the
// psql / SQL Editor / `supabase db push` routes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { log, err, heading, status, c } from '../shared/util.mjs';
import { probeByodStorage } from '../shared/byod.mjs';

// The bootstrap.sql file is at <repo-root>/supabase/byod/bootstrap.sql.
// This file lives at packages/cli/src/commands/bootstrap.mjs, so the relative
// path from here to the repo root is ../../../../  (commands → src → cli →
// packages → root).
const BOOTSTRAP_SQL_PATH = fileURLToPath(
  new URL('../../../../supabase/byod/bootstrap.sql', import.meta.url),
);
const BOOTSTRAP_SQL_URL = 'https://raw.githubusercontent.com/mthines/lorekit/main/supabase/byod/bootstrap.sql';

// The checkout copy next to this file, else one under the current directory
// (running from a LoreKit checkout), else null (an npm install).
function locateBootstrapSql() {
  if (fs.existsSync(BOOTSTRAP_SQL_PATH)) return BOOTSTRAP_SQL_PATH;
  const cwdPath = path.resolve(process.cwd(), 'supabase/byod/bootstrap.sql');
  return fs.existsSync(cwdPath) ? cwdPath : null;
}

export async function bootstrap(_args) {
  heading('LoreKit bootstrap');

  const storageUrl = process.env['LOREKIT_STORAGE_URL'];
  const storageServiceKey = process.env['LOREKIT_STORAGE_SERVICE_KEY'];
  const storageAnonKey = process.env['LOREKIT_STORAGE_ANON_KEY'];

  // If no BYOD env vars are set, this command is a no-op — it's only for BYOD.
  if (!storageUrl && !storageServiceKey && !storageAnonKey) {
    log('');
    log(
      `  ${c.cyan('•')} No BYOD storage configured — ${c.dim('bootstrap is only needed for custom databases.')}`,
    );
    log('');
    log('  Set LOREKIT_STORAGE_URL and LOREKIT_STORAGE_ANON_KEY (or LOREKIT_STORAGE_SERVICE_KEY)');
    log('  for your own Supabase project, then re-run this command.');
    log('');
    log('  See docs/byod.md for setup instructions.');
    return 0;
  }

  if (!storageUrl) {
    err(`${c.red('Error:')} a LOREKIT_STORAGE_*_KEY is set but LOREKIT_STORAGE_URL is missing.`);
    err('  Set LOREKIT_STORAGE_URL to the storage project\'s URL and try again.');
    return 1;
  }

  // The published npm package does not ship supabase/, so outside a LoreKit
  // checkout there is no local file — that is the normal case, not an error:
  // probe anyway and point at the file's download URL.
  const sqlPath = locateBootstrapSql();
  if (sqlPath) status('pass', 'bootstrap.sql', sqlPath);
  else status('info', 'bootstrap.sql', `not in this install — download: ${BOOTSTRAP_SQL_URL}`);
  status('info', 'storage url', storageUrl);

  // Probe the project with whichever key is set (the anon key when both are,
  // so the check runs with the least privilege that can answer it).
  const probeKey = storageAnonKey || storageServiceKey;
  if (probeKey) {
    const probe = await probeByodStorage({ url: storageUrl, key: probeKey });
    if (probe.state === 'ready') {
      status('pass', 'connectivity', 'connected — LoreKit schema already present');
      log('');
      log('  bootstrap.sql only initialises an EMPTY database. To upgrade this one, run');
      log(`  from a LoreKit checkout: ${c.cyan('supabase link --project-ref')} ${parseRef(storageUrl)} && ${c.cyan('supabase db push')}`);
      log('');
      return 0;
    }
    if (probe.state === 'no-schema') status('info', 'connectivity', 'connected — schema not applied yet');
    else status('warn', 'connectivity', probe.detail);
  } else {
    status('info', 'connectivity', 'skipped — no LOREKIT_STORAGE_ANON_KEY / LOREKIT_STORAGE_SERVICE_KEY set');
  }

  // PostgREST cannot run DDL, so the schema goes in over a Postgres connection
  // (psql) or the SQL Editor. Never print a key here: the connection string's
  // password is the DATABASE password, which is not the service-role API key.
  const sqlArg = sqlPath ?? 'bootstrap.sql';
  log('');
  log(`  ${c.bold('To apply the schema, run:')}`);
  log('');
  if (!sqlPath) log(`    ${c.cyan('curl -fsSLO')} ${BOOTSTRAP_SQL_URL}`);
  log(`    ${c.cyan('psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f')} ${sqlArg}`);
  log('');
  log(`  ${c.dim('$DATABASE_URL is the connection string from the Supabase dashboard → Connect;')}`);
  log(`  ${c.dim('its password is your database password, not an API key.')}`);
  log('');
  log(`  Or paste the contents of ${c.dim(sqlArg)}`);
  log('  into the Supabase dashboard → SQL Editor and run it.');
  log('');
  log(`  Or, from a LoreKit checkout: ${c.cyan('supabase link --project-ref')} ${parseRef(storageUrl)} && ${c.cyan('supabase db push')}`);
  log('');

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
