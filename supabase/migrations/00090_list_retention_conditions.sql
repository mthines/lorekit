-- Explorer preview of retention-policy conditions: the SAME three thresholds
-- `lorekit_groom_candidates` (00088) matches a saved policy on, added to
-- `lorekit_memory_list` (00067/00069) so the dashboard's Lore Explorer can
-- filter its list to the lessons a policy WOULD catch, before any policy is
-- ever saved. This is the "verify before you run it" gap: `groom.preview`
-- already answers "how many and which keys", but the Explorer renders full
-- lesson cards, not a bare key list, and a reader wants to see those cards
-- narrowed the same way the filter bar narrows every other dimension.
--
-- Deliberately NOT folded into `lorekit_groom_candidates` itself, and not a
-- ninth `MemoryDimensions` entry: these three are numeric THRESHOLDS against
-- `created_at`/`last_seen_at`/`seen_count`, not a categorical value-list like
-- `tags`/`kind`/`host`, so they compose with the list route's OWN predicate
-- rather than the dimension-filter helpers (00066). The predicate expression
-- is copied verbatim from `lorekit_groom_candidates` (00088) — same three
-- conditions, same "never-seen coalesces to `-infinity`" reading of
-- `unseen_days` — so a value that would match a saved policy always matches
-- here too; `groom.spec.ts`'s TypeScript mirror is unaffected, since this
-- migration adds a second SQL caller of the same rule rather than changing it.
--
-- Purely ADDITIVE: three new trailing parameters, all defaulting to `null`
-- ("not filtered"), so behaviour is unchanged for every existing caller —
-- the CLI, the MCP surface, and every caller that does not pass them see the
-- exact same rows as before. Callers use PostgREST's named-argument RPC form
-- (a JSON object, not a positional call), so appending parameters at the END
-- of the signature — rather than inserting them in reading order — needs no
-- renumbering of any `$N` placeholder already in the function body; the
-- three new placeholders are likewise appended to the end of the
-- `using (...)` list.
--
-- `create or replace` only replaces a function with the SAME argument list;
-- it cannot change a signature. The existing 35-arg overload (00069) has to
-- be dropped first, or it and this new 38-arg one coexist as two overloads —
-- PostgREST's named-argument RPC form then can't pick one and every call
-- through `lorekit_memory_list` becomes ambiguous.
drop function if exists lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[]
);

create or replace function lorekit_memory_list(
  p_user_id              uuid,
  p_archived             boolean     default false,
  p_scope                text        default null,
  p_key                  text        default null,
  p_key_prefix           text        default null,
  p_q                    text        default null,
  p_created_since        timestamptz default null,
  p_created_until        timestamptz default null,
  p_expires_after        timestamptz default null,
  p_expires_on_or_before timestamptz default null,
  p_tags                 text[]      default null,
  p_tags_mode            text        default 'any',
  p_source_agent         text[]      default null,
  p_source_agent_mode    text        default 'in',
  p_trigger              text[]      default null,
  p_trigger_mode         text        default 'in',
  p_kind                 text[]      default null,
  p_kind_mode            text        default 'in',
  p_host                 text[]      default null,
  p_host_mode            text        default 'in',
  p_origin_repo          text[]      default null,
  p_origin_repo_mode     text        default 'in',
  p_origin_branch        text[]      default null,
  p_origin_branch_mode   text        default 'in',
  p_origin_pr            text[]      default null,
  p_origin_pr_mode       text        default 'in',
  p_owner                text[]      default null,
  p_owner_mode           text        default 'in',
  p_sort                 text        default 'updated_at',
  p_cursor_ts            timestamptz default null,
  p_cursor_id            uuid        default null,
  p_limit                integer     default 51,
  p_key_scopes           text[]      default '{}',
  p_key_org_access       text        default 'all',
  p_key_org_ids          uuid[]      default '{}',
  -- The retention-policy preview trio (see header). All optional; `null`
  -- (the default) applies no filter, exactly like every other parameter here.
  p_min_age_days         integer     default null,
  p_unseen_days          integer     default null,
  p_max_seen_count       integer     default null
)
returns table (
  id            uuid,
  scope         text,
  key           text,
  value         text,
  tags          text[],
  source_agent  text,
  trigger       text,
  created_at    timestamptz,
  updated_at    timestamptz,
  expires_at    timestamptz,
  archived_at   timestamptz,
  origin_repo   text,
  origin_branch text,
  origin_commit text,
  origin_pr     integer,
  kind          text,
  host          text,
  seen_count    integer,
  org_id        uuid,
  created_by    uuid,
  updated_by    uuid,
  org_name      text,
  org_slug      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
  v_origin_pr integer[] := (
    select array_agg(x::integer)
      from unnest(coalesce(p_origin_pr, '{}'::text[])) as x
     where x ~ '^0*[0-9]{1,9}$'
  );
  v_sort text := case when p_sort = 'created_at' then 'created_at' else 'updated_at' end;
begin
  return query execute format($q$
    select
      m.id, m.scope, m.key, m.value, m.tags, m.source_agent, m.trigger,
      m.created_at, m.updated_at, m.expires_at, m.archived_at,
      m.origin_repo, m.origin_branch, m.origin_commit, m.origin_pr,
      m.kind, m.host, m.seen_count,
      m.org_id, m.created_by, m.updated_by,
      o.name as org_name, o.slug as org_slug
      from memories m
      left join orgs o on o.id = m.org_id
     where (
             ($1 is null and auth.role() = 'service_role')
             or m.user_id = $1
             or m.org_id in (select lorekit_member_org_ids($1))
           )
       and lorekit_api_token_scope_allowed($32, m.scope)
       and lorekit_api_token_org_allowed($33, $34, m.org_id)
       and (
             case
               when $2 then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
       and ($3 is null or m.scope = $3)
       and ($4 is null or m.key = $4)
       and ($5 is null or m.key ilike $5 || '%%')
       and ($6 is null or m.key ilike '%%' || $6 || '%%' or m.value ilike '%%' || $6 || '%%')
       and ($7 is null or m.created_at >= $7)
       and ($8 is null or m.created_at < $8)
       and ($9  is null or m.expires_at > $9)
       and ($10 is null or m.expires_at <= $10)
       and lorekit_match_tags(m.tags,          $11, $12)
       and lorekit_match_text(m.source_agent,  $13, $14)
       and lorekit_match_text(m.trigger,       $15, $16)
       and lorekit_match_text(m.kind,          $17, $18)
       and lorekit_match_text(m.host,          $19, $20)
       and lorekit_match_text(m.origin_repo,   $21, $22)
       and lorekit_match_text(m.origin_branch, $23, $24)
       and lorekit_match_int (m.origin_pr,     $25, $26)
       and ($27 is null or case coalesce($28, 'in')
             when 'nin' then (
               (case when m.org_id is null then 'personal' else o.slug end) is not null
               and (case when m.org_id is null then 'personal' else o.slug end) <> all($27)
             )
             else (
               ('personal' = any($27) and m.org_id is null)
               or (m.org_id is not null and o.slug = any($27))
             )
           end)
       -- The retention-policy preview trio, copied verbatim from
       -- `lorekit_groom_candidates` (00088) — see header.
       and ($35 is null or m.created_at <= now() - ($35 * interval '1 day'))
       and ($36 is null or coalesce(m.last_seen_at, '-infinity'::timestamptz) <= now() - ($36 * interval '1 day'))
       and ($37 is null or m.seen_count <= $37)
       and (
             $29 is null
             or m.%1$I < $29
             or (m.%1$I = $29 and m.id < $30)
           )
     order by m.%1$I desc, m.id desc
     limit $31
  $q$, v_sort)
  using
    v_actor, coalesce(p_archived, false), p_scope, p_key, p_key_prefix, p_q,
    p_created_since, p_created_until, p_expires_after, p_expires_on_or_before,
    p_tags, p_tags_mode,
    p_source_agent, p_source_agent_mode,
    p_trigger, p_trigger_mode,
    p_kind, p_kind_mode,
    p_host, p_host_mode,
    p_origin_repo, p_origin_repo_mode,
    p_origin_branch, p_origin_branch_mode,
    v_origin_pr, p_origin_pr_mode,
    p_owner, p_owner_mode,
    p_cursor_ts, p_cursor_id,
    greatest(coalesce(p_limit, 51), 1),
    coalesce(p_key_scopes, '{}'::text[]),
    coalesce(p_key_org_access, 'all'),
    coalesce(p_key_org_ids, '{}'::uuid[]),
    p_min_age_days, p_unseen_days, p_max_seen_count;
end;
$$;

revoke execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer
) from public, anon;
grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer
) to authenticated, service_role;
