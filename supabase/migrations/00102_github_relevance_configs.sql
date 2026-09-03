-- ═════════════════════════════════════════════════════════════════════════
-- Server-side review-comment relevance classification — per-installation
-- configuration.
--
-- WHAT THIS ENABLES
--   A review agent posts findings as PR review comments.  Later, the thread is
--   resolved, declined, or merged still open.  That outcome is the only honest
--   signal about whether the finding was worth posting, and until now capturing
--   it required every consumer repository to install a GitHub Actions workflow
--   plus a LOREKIT_API_KEY secret.  The GitHub App already receives the same
--   deliveries, so the classification can run server-side and a consumer gets
--   it by installing the App — no workflow, no secret.
--
-- WHY IT NEEDS CONFIGURATION AT ALL
--   LoreKit must NOT learn any particular agent's vocabulary.  It does not know
--   what a "finder", a "defect class", or a fingerprint is, and it must never
--   have to.  So the account that installed the App declares, once, three
--   things about its own review agent:
--
--     • marker_open / marker_close — the literal delimiters the agent wraps its
--       per-finding identifier in, inside the comment body.
--     • bucket_tag                 — the LoreKit tag the outcome is filed under.
--     • key_prefix                 — the key namespace the outcome is filed in.
--     • agent_name                 — what to record as the finding's author.
--
--   `agent_name` exists because the consuming reader filters on it: another
--   bot's declined finding and a human's incidental comment have their own
--   false-positive profiles and must never train this agent's suppressor.  The
--   account is the only party that can name its agent, and a comment carrying
--   the account's own marker is by definition from it — so the marker is the
--   attribution and this column is what it attributes to.  LoreKit does not
--   otherwise use the value.
--
--   The identifier between the delimiters is copied VERBATIM and treated as an
--   opaque string.  LoreKit never parses it, never splits it, never derives
--   meaning from it.  That is the whole separation: LoreKit owns the mechanism
--   (receive, read, classify, write); the account owns the vocabulary.
--
-- WHY LITERAL DELIMITERS AND NOT A REGEX
--   A caller-supplied regex compiled inside an edge function is a
--   catastrophic-backtracking vector, and "reject the dangerous patterns" is
--   not a check anyone can write soundly.  Two literal delimiters answer the
--   same question in linear time with nothing to validate beyond length, and a
--   human can read the stored config and know exactly what it matches.
--
-- SECURITY POSTURE — the config IS the boundary
--   Anyone who can comment on a PR in a covered repository can cause a write.
--   That is already true of the `source::pr-webhook` candidate feed, but a
--   classified record is filed under a DERIVED key, so an unbounded key would
--   let a commenter address — and overwrite — an arbitrary existing record.
--   Three things bound it:
--     a) The account, not the comment, supplies `key_prefix` and `bucket_tag`.
--        A commenter can only ever influence the suffix, inside a namespace the
--        account itself declared.
--     b) The extracted identifier must pass a strict charset + length check
--        (`isSafeMarkerValue`, comment-relevance.ts) or nothing is written.
--     c) The write is scoped to `repo::<full_name>` of the delivery, which is
--        HMAC-verified before any of this runs.
--
-- WHY THE ROW CARRIES NO user_id
--   Ownership comes from the installation, resolved at write time through
--   `github_installations.user_id`.  Storing it here too would let the two
--   disagree after an installation is transferred, and the installation row is
--   the one the reconcile path already keeps correct.
--
-- Authorization posture (matches 00037 and the Phase 3 org rule):
--   • RLS grants SELECT on rows whose installation is linked to auth.uid().
--   • There is NO insert/update/delete policy.  Every state transition goes
--     through a SECURITY DEFINER RPC that checks installation ownership.
--   • The edge function reads through `lorekit_relevance_config_for_repo`,
--     service-role only, which resolves repo → installation → owner → config
--     in one round trip.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. github_relevance_configs — one row per (installation, bucket).
create table github_relevance_configs (
  id              uuid primary key default gen_random_uuid(),
  installation_id bigint not null
                    references github_installations(installation_id) on delete cascade,

  -- Literal delimiters around the agent's opaque per-finding identifier.
  -- `marker_open` is at least 4 characters so a config cannot be written that
  -- matches near-arbitrary prose; `marker_close` may be short (`-->`).
  marker_open     text not null check (length(marker_open) between 4 and 120),
  marker_close    text not null check (length(marker_close) between 1 and 120),

  -- Where the outcome is filed. Both are the account's vocabulary, never a
  -- commenter's — see the security posture above.
  bucket_tag      text not null check (bucket_tag ~ '^[a-z0-9]+(::[a-z0-9._-]+)+$'),
  key_prefix      text not null check (length(key_prefix) between 1 and 200),
  agent_name      text not null check (length(agent_name) between 1 and 60),

  -- Taxonomy applied to the written record. LoreKit infers kind/host only from
  -- a `loop::` tag, so a `ci::`-tagged bucket must state them explicitly.
  record_kind     text not null default 'signal'
                    check (record_kind in ('lesson', 'bus', 'signal')),
  record_host     text check (record_host is null or length(record_host) between 1 and 60),

  ttl_days        int not null default 60 check (ttl_days between 1 and 365),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One active config per (installation, bucket): an account can classify into
-- more than one bucket, but never twice into the same one with two different
-- markers, which would make the write order decide the record.
create unique index github_relevance_configs_active_uniq
  on github_relevance_configs (installation_id, bucket_tag)
  where active = true;

create index github_relevance_configs_installation_id_idx
  on github_relevance_configs (installation_id)
  where active = true;

alter table github_relevance_configs enable row level security;

-- Readable by the owner of the installation, and by the service role.
create policy "rls_github_relevance_configs_select"
  on github_relevance_configs for select
  using (
    installation_id in (
      select i.installation_id
        from github_installations i
       where i.user_id = auth.uid() and i.status = 'linked'
    )
  );

grant select on github_relevance_configs to authenticated, service_role;

-- 2. Edge lookup — repo full_name → the configs to classify with, plus the
--    LoreKit user the resulting records belong to.
--
--    Returns ZERO rows for every honest no-op, and the caller treats them
--    identically: the repo is not covered by any installation, the installation
--    is still `pending` (nobody to attribute the write to), or the account has
--    declared no marker.  None of those is an error.
--
--    `status = 'linked'` is load-bearing rather than cosmetic: a webhook write
--    with a null user_id lands in the service-role partition, which no user
--    token can read back (see `applyTenantScope`), so classifying for a pending
--    installation would produce records that exist and are unreachable.
create or replace function lorekit_relevance_config_for_repo(p_repo text)
returns table (
  installation_id bigint,
  user_id         uuid,
  marker_open     text,
  marker_close    text,
  bucket_tag      text,
  key_prefix      text,
  agent_name      text,
  record_kind     text,
  record_host     text,
  ttl_days        int
)
language sql
stable
security definer
set search_path = public
as $$
  select c.installation_id,
         i.user_id,
         c.marker_open,
         c.marker_close,
         c.bucket_tag,
         c.key_prefix,
         c.agent_name,
         c.record_kind,
         c.record_host,
         c.ttl_days
    from installation_repositories r
    join github_installations i
      on i.installation_id = r.installation_id
    join github_relevance_configs c
      on c.installation_id = r.installation_id
   where r.full_name = lower(p_repo)
     and r.active = true
     and i.status = 'linked'
     and i.user_id is not null
     and c.active = true;
$$;

grant execute on function lorekit_relevance_config_for_repo(text) to service_role;

-- 3. Owner-only upsert. The caller proves ownership by owning the installation;
--    no caller-supplied user_id is trusted and there is no UPDATE policy to
--    reach the table any other way.
create or replace function lorekit_relevance_config_set(
  p_installation_id bigint,
  p_marker_open     text,
  p_marker_close    text,
  p_bucket_tag      text,
  p_key_prefix      text,
  p_agent_name      text,
  p_record_kind     text default 'signal',
  p_record_host     text default null,
  p_ttl_days        int  default 60
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1
      from github_installations i
     where i.installation_id = p_installation_id
       and i.user_id = auth.uid()
       and i.status = 'linked'
  ) then
    raise exception 'installation not found or not linked to caller';
  end if;

  insert into github_relevance_configs (
    installation_id, marker_open, marker_close, bucket_tag, key_prefix, agent_name,
    record_kind, record_host, ttl_days, active, updated_at
  )
  values (
    p_installation_id, p_marker_open, p_marker_close, p_bucket_tag, p_key_prefix, p_agent_name,
    coalesce(p_record_kind, 'signal'), p_record_host, coalesce(p_ttl_days, 60), true, now()
  )
  on conflict (installation_id, bucket_tag) where active = true
  do update set
    marker_open  = excluded.marker_open,
    marker_close = excluded.marker_close,
    key_prefix   = excluded.key_prefix,
    agent_name   = excluded.agent_name,
    record_kind  = excluded.record_kind,
    record_host  = excluded.record_host,
    ttl_days     = excluded.ttl_days,
    updated_at   = now()
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function lorekit_relevance_config_set(bigint, text, text, text, text, text, text, text, int)
  to authenticated;

-- 4. Owner-only deactivate. Soft, so the unique index frees up for a new
--    config while the history of what was configured stays readable.
create or replace function lorekit_relevance_config_deactivate(
  p_installation_id bigint,
  p_bucket_tag      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
      from github_installations i
     where i.installation_id = p_installation_id
       and i.user_id = auth.uid()
       and i.status = 'linked'
  ) then
    raise exception 'installation not found or not linked to caller';
  end if;

  update github_relevance_configs
     set active = false, updated_at = now()
   where installation_id = p_installation_id
     and bucket_tag = p_bucket_tag
     and active = true;
end;
$$;

grant execute on function lorekit_relevance_config_deactivate(bigint, text)
  to authenticated;
