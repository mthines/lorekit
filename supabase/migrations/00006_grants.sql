-- Explicit table privileges for the Supabase API roles.
--
-- Supabase cloud projects grant DML to anon/authenticated/service_role via
-- ambient "default privileges", so this is effectively a no-op in staging and
-- production. But a fresh local `supabase start` (newer CLI) only grants
-- TRUNCATE/REFERENCES/TRIGGER to these roles, leaving them without
-- SELECT/INSERT/UPDATE/DELETE — so any service-role or api_key request fails
-- with "permission denied for table ...", and PostgREST won't expose an
-- ON CONFLICT arbiter for upserts. Granting explicitly makes the schema
-- self-contained and identical across every environment.
--
-- This grants no new *effective* access: anon/authenticated remain governed by
-- the RLS policies defined in earlier migrations; service_role bypasses RLS as
-- it already does. It only makes the underlying table privileges explicit.

grant select, insert, update, delete on all tables in schema public
  to anon, authenticated, service_role;

-- Tables created by future migrations inherit the same grants automatically.
alter default privileges in schema public
  grant select, insert, update, delete on tables
  to anon, authenticated, service_role;
