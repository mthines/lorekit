-- LoreKit BYOD storage overlay
--
-- Apply to a BYOD STORAGE database only — the separate Supabase project that
-- holds memory rows — after the schema, and again after every
-- `supabase db push` upgrade. Idempotent. bootstrap.sql already ends with it.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/byod/storage-overlay.sql
--
-- Why: in BYOD, users and API tokens live in the project that runs the `mcp`
-- function; the storage project's auth.users never holds them. Every foreign
-- key from a public table into auth.users therefore rejects legitimate rows —
-- memory_write fails with memories_user_id_fkey for every lk_* token. Dropping
-- those keys is the overlay's only change. The ON DELETE CASCADE / SET NULL
-- they carried pointed at users this database never has; deleting a user in
-- the function's project does not remove their rows here.
--
-- Never apply it to the project that RUNS the mcp function (hosted or
-- self-hosted): there auth.users is the real user table and the cascades
-- matter.
--
-- The keys are found by query, not by name, so a migration that adds another
-- user foreign key is covered by re-running this after the upgrade.
do $overlay$
declare
  fk record;
begin
  for fk in
    select con.conrelid::regclass as tbl, con.conname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and n.nspname = 'public'
  loop
    execute format('alter table %s drop constraint %I', fk.tbl, fk.conname);
  end loop;
end
$overlay$;
