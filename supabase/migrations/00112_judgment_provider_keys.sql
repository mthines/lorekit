-- TypeSafe (Jev) judgment — the Vault-backed, per-user BYOK key store (D12).
--
-- `judgment_provider_keys` holds only METADATA (owner, provider, last4,
-- status, version, calls_total). The decrypted value never lives in this
-- table — it is stored via Supabase Vault (`vault.create_secret` /
-- `vault.decrypted_secrets`) and this table keeps only the returned
-- `vault_secret_id`, mirroring the standard Supabase per-row-secret pattern.
-- This is the FIRST per-user Vault secret in this schema: every prior use
-- (00074, 00095) is a single operator-provisioned, service-role-only global
-- secret, looked up by a fixed `name` — that shape does not extend to "one
-- secret per user", which is why this migration introduces the anonymous
-- (`name := null`) create-by-id variant instead.
--
-- LOCKDOWN, not RLS: `anon`/`authenticated` get NO table privileges and there
-- is no RLS policy at all (default-deny once RLS is enabled) — every
-- `lorekit_judgment_key_*` RPC is `security definer`, granted to
-- `service_role` ONLY. The one and only caller is
-- `supabase/functions/_shared/judgment/judgment-keys.ts`, which opens its OWN
-- `serviceClient()` regardless of the REST request's own auth tier (a JWT
-- caller's user-scoped client could not call these RPCs at all) and passes
-- `p_user_id` from the verified auth context — never from request
-- body/query/params (AC-6). A JWT-only REST surface
-- (`requires: 'jwt'` on all three `/memories/judgment-key` routes) is the
-- outer gate; this table's own lockdown is the inner one, so a future route
-- that forgets the outer gate still cannot reach another user's key.
--
-- VERSIONING: `version` increments on every `_set` (including a rotate).
-- `_record_call` is version-guarded — it updates a row only when the version
-- it was called with still matches, so a TypeSafe response for a key that has
-- since been rotated cannot flip the NEW key's status or inflate its call
-- count. See `_record_call`'s own comment.

create table judgment_provider_keys (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  provider          text not null default 'typesafe',
  vault_secret_id   uuid not null,
  last4             text not null,
  status            text not null default 'active' check (status in ('active', 'rejected')),
  version           integer not null default 1,
  calls_total       integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, provider)
);

comment on table judgment_provider_keys is
  'Per-user BYOK provider keys for TypeSafe (Jev) judgment reranking. The '
  'decrypted value lives in Vault (vault_secret_id); this table is metadata '
  'only. No RLS policy — access is entirely through the lorekit_judgment_key_* '
  'security definer functions below, service_role-only.';

alter table judgment_provider_keys enable row level security;
revoke all on table judgment_provider_keys from anon, authenticated;

-- ── lorekit_judgment_key_set ─────────────────────────────────────────────────
-- Store a brand-new key, or rotate the existing one. Rotating overwrites the
-- SAME vault row (no orphaned secret left behind) and bumps `version`.
create or replace function lorekit_judgment_key_set(
  p_user_id  uuid,
  p_provider text,
  p_api_key  text,
  p_last4    text
)
returns table (version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_id     uuid;
  v_vault_secret_id uuid;
  v_version         integer;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'judgment_vault_unavailable' using errcode = 'P0001';
  end if;

  select jpk.id, jpk.vault_secret_id, jpk.version
    into v_existing_id, v_vault_secret_id, v_version
    from judgment_provider_keys jpk
    where jpk.user_id = p_user_id and jpk.provider = p_provider
    for update;

  if v_existing_id is not null then
    perform vault.update_secret(v_vault_secret_id, p_api_key);
    v_version := v_version + 1;
    update judgment_provider_keys
      set last4 = p_last4,
          status = 'active',
          version = v_version,
          updated_at = now()
      where id = v_existing_id;
  else
    v_vault_secret_id := vault.create_secret(p_api_key, null, 'lorekit judgment key');
    v_version := 1;
    insert into judgment_provider_keys (user_id, provider, vault_secret_id, last4, status, version)
    values (p_user_id, p_provider, v_vault_secret_id, p_last4, 'active', v_version);
  end if;

  return query select v_version;
end;
$$;

comment on function lorekit_judgment_key_set(uuid, text, text, text) is
  'Store or rotate the caller''s own BYOK provider key (Vault-backed). '
  'Rotating bumps `version` so an in-flight call graded against the old key '
  'cannot flip the new key''s status. service_role only.';

revoke all on function lorekit_judgment_key_set(uuid, text, text, text) from public;
revoke all on function lorekit_judgment_key_set(uuid, text, text, text) from anon, authenticated;
grant execute on function lorekit_judgment_key_set(uuid, text, text, text) to service_role;

-- ── lorekit_judgment_key_get ─────────────────────────────────────────────────
-- Decrypt the caller's own key for the ONE call site that sends it over the
-- wire. No rows when unconfigured OR when Vault is unavailable — never an
-- error, so a missing key degrades to the pre-BYOK baseline.
create or replace function lorekit_judgment_key_get(
  p_user_id  uuid,
  p_provider text
)
returns table (decrypted_secret text, version integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return;
  end if;

  return query
    select vs.decrypted_secret, jpk.version
      from judgment_provider_keys jpk
      join vault.decrypted_secrets vs on vs.id = jpk.vault_secret_id
      where jpk.user_id = p_user_id and jpk.provider = p_provider;
end;
$$;

comment on function lorekit_judgment_key_get(uuid, text) is
  'Decrypt the caller''s own BYOK provider key for judgment-client.ts. No rows '
  'when unconfigured or Vault is unavailable — never an error.';

revoke all on function lorekit_judgment_key_get(uuid, text) from public;
revoke all on function lorekit_judgment_key_get(uuid, text) from anon, authenticated;
grant execute on function lorekit_judgment_key_get(uuid, text) to service_role;

-- ── lorekit_judgment_key_status ──────────────────────────────────────────────
-- Reports configuration state WITHOUT ever touching the decrypted value — this
-- SELECT list has no vault.decrypted_secrets join, by construction, so the
-- secret cannot leak through a settings panel's status poll.
create or replace function lorekit_judgment_key_status(
  p_user_id  uuid,
  p_provider text
)
returns table (last4 text, status text, calls_total integer, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select jpk.last4, jpk.status, jpk.calls_total, jpk.created_at
      from judgment_provider_keys jpk
      where jpk.user_id = p_user_id and jpk.provider = p_provider;
end;
$$;

comment on function lorekit_judgment_key_status(uuid, text) is
  'Report whether a BYOK key is configured, without ever touching the '
  'decrypted value. Zero rows means "not configured".';

revoke all on function lorekit_judgment_key_status(uuid, text) from public;
revoke all on function lorekit_judgment_key_status(uuid, text) from anon, authenticated;
grant execute on function lorekit_judgment_key_status(uuid, text) to service_role;

-- ── lorekit_judgment_key_delete ──────────────────────────────────────────────
-- Removes the metadata row. The matching Vault secret is removed by the
-- AFTER DELETE trigger below, which also fires on the auth.users cascade —
-- one cleanup path for both an explicit delete and an account deletion.
create or replace function lorekit_judgment_key_delete(
  p_user_id  uuid,
  p_provider text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  delete from judgment_provider_keys
    where user_id = p_user_id and provider = p_provider
    returning id into v_id;

  return v_id is not null;
end;
$$;

comment on function lorekit_judgment_key_delete(uuid, text) is
  'Remove the caller''s own BYOK key row. The Vault secret is removed by the '
  'row-level AFTER DELETE trigger, not here.';

revoke all on function lorekit_judgment_key_delete(uuid, text) from public;
revoke all on function lorekit_judgment_key_delete(uuid, text) from anon, authenticated;
grant execute on function lorekit_judgment_key_delete(uuid, text) to service_role;

-- ── lorekit_judgment_key_record_call ─────────────────────────────────────────
-- Count one TypeSafe call attempt and, VERSION-GUARDED, flip active/rejected
-- from the classified outcome (classifyHttpStatus in judgment.ts). The update
-- predicate includes `version = p_version`: if the key was rotated between
-- judgment-client.ts loading it and this call recording the outcome, the
-- update matches zero rows — the stale outcome is silently dropped rather than
-- mis-flipping a row that no longer represents the key that was actually
-- called. A non-'rejected' outcome self-heals status back to 'active', so a
-- previously-rejected key is not permanently stuck once it starts succeeding.
create or replace function lorekit_judgment_key_record_call(
  p_user_id  uuid,
  p_provider text,
  p_version  integer,
  p_outcome  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update judgment_provider_keys
    set calls_total = calls_total + 1,
        status = case when p_outcome = 'rejected' then 'rejected' else 'active' end,
        updated_at = now()
    where user_id = p_user_id and provider = p_provider and version = p_version;
end;
$$;

comment on function lorekit_judgment_key_record_call(uuid, text, integer, text) is
  'Count one call attempt and, version-guarded, flip active/rejected from the '
  'classified outcome. A rotated key''s version no longer matches, so a stale '
  'outcome after a rotate updates nothing.';

revoke all on function lorekit_judgment_key_record_call(uuid, text, integer, text) from public;
revoke all on function lorekit_judgment_key_record_call(uuid, text, integer, text) from anon, authenticated;
grant execute on function lorekit_judgment_key_record_call(uuid, text, integer, text) to service_role;

-- ── Vault cleanup trigger ────────────────────────────────────────────────────
-- Fires on BOTH an explicit lorekit_judgment_key_delete call and the
-- auth.users → judgment_provider_keys ON DELETE CASCADE (account deletion) —
-- one cleanup path removes the Vault secret in either case.
create or replace function lorekit_judgment_key_vault_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end;
$$;

comment on function lorekit_judgment_key_vault_cleanup() is
  'AFTER DELETE row trigger on judgment_provider_keys — removes the matching '
  'Vault secret so a deleted key never leaves an orphaned vault.secrets row.';

create trigger judgment_provider_keys_vault_cleanup
  after delete on judgment_provider_keys
  for each row
  execute function lorekit_judgment_key_vault_cleanup();
