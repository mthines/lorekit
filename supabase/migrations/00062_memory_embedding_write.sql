-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_set_embedding — the ONE authorised path for writing a
-- memory's vector.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────
-- The write-path embedder (`_shared/embed-on-write.ts`) updated `memories`
-- directly, with whatever client the request happened to arrive on. That is
-- correct on two of the three auth tiers and SILENTLY wrong on the third:
--
--   * `service` and `api_key` both hold a service-role client, and `rls_update`
--     (00001) admits `auth.role() = 'service_role'`, so the update lands.
--
--   * a Supabase JWT holds an RLS-scoped client, and `rls_update` admits only
--     `user_id = auth.uid()`. The READ policies were widened for orgs in 00015
--     (`org_id in (select lorekit_member_org_ids(auth.uid()))`); `rls_update`
--     never was. An ORG-OWNED memory carries `user_id is null` (00019), so the
--     UPDATE matched ZERO ROWS — and a zero-row update is not an error in
--     PostgREST. The embedding was dropped with no signal anywhere, and the
--     row waited for a manual backfill that an operator had no reason to run.
--
-- The asymmetry is the whole bug: SELECT knows about orgs, UPDATE does not.
--
-- ── WHY NOT SIMPLY WIDEN `rls_update` ────────────────────────────────────
-- Making UPDATE symmetric with SELECT would fix the embed and open a hole:
-- every org MEMBER could then rewrite any column of any org memory straight
-- through PostgREST, with no role check at all. Org writes are gated on
-- `lorekit_org_can(…, 'write')` — a VIEWER must not write — and that gate lives
-- in RPCs precisely because RLS cannot express it. Widening the policy would
-- silently demote a role check to a membership check, on every column, for
-- every caller. The embedding is not worth that.
--
-- ── WHY NOT MIRROR `memory_write`'s BRANCHING IN THE EDGE ────────────────
-- Two copies of an ownership rule drift, and the copy in TypeScript is the one
-- no migration test ever runs. 00019's branching would have to be restated in
-- Deno and kept in step by review alone.
--
-- ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────
-- One SECURITY DEFINER function — the shape 00022/00041 established for every
-- org state transition — with authorisation derived INSIDE it from the same
-- predicates the rest of the schema already uses:
--
--   * `lorekit_org_actor`  (00041) resolves WHO is acting: a service-role
--     caller may name the user it acts for, a JWT caller is only ever itself.
--   * `lorekit_org_can`    (00017) is the ROLE gate for an org-owned row —
--     the same 'write' capability `memory_write` demanded to create it.
--   * personal rows compare against the resolved actor directly.
--
-- Nothing here re-implements an ownership rule; it composes the existing ones.
-- If the ownership model changes, it changes in those functions and this
-- inherits it.
--
-- ── IT REPORTS WHETHER IT WROTE, AND THAT IS THE OTHER HALF OF THE FIX ───
-- The original defect was not merely that the update failed — it is that it
-- failed INVISIBLY. This reports whether a row was actually written so the
-- caller can record a miss on its span. If some future ownership model escapes
-- these predicates, it surfaces as a signal instead of an empty column nobody
-- notices until a semantic search quietly comes back thin.
--
-- `returns table (written boolean)` rather than a bare `returns boolean`: it is
-- the shape `memory_delete` (00020) already uses for a did-it-land answer, and
-- the one the edge's traced client types honestly — `TracedQuery<T>` resolves to
-- `PostgrestResponse<T[]>`, so a scalar-returning function would have to be read
-- through an `unknown` cast at every call site.
--
-- ── search_path NAMES `extensions` ON PURPOSE ────────────────────────────
-- Every other function in this schema pins `set search_path = public`. This one
-- cannot: it casts to `vector(1536)`, and Supabase provisions `vector` in the
-- `extensions` schema on hosted projects (see 00060's header). Pinning `public`
-- alone would resolve locally, where the extension lands in the search path
-- already, and fail in production with `type "vector" does not exist` — inside a
-- backgrounded task whose errors are swallowed by design. Naming both schemas
-- is what makes the local run and the hosted run the same run.
-- ═════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════
-- PART 1 — an embedding write must not disturb `updated_at`.
--
-- `memories_updated_at` (00001) is a BEFORE UPDATE trigger that sets
-- `updated_at = now()` unconditionally. That is right for an edit and WRONG for
-- an embedding: the vector is a DERIVED artefact, not a change to what the
-- lesson says. `updated_at` is the recency signal `POST /memories/search` and
-- `GET /memories/relevant` order by, that `memory.list` keysets on
-- (`memories_scope_updated_at_id_idx`), and that `lesson-rank` scores.
--
-- On the write path the damage is nil — the row was created moments earlier.
-- A WHOLE-STORE BACKFILL is the problem: it walks `created_at desc` and would
-- restamp every row in that order, collapsing the store's real recency ordering
-- into the order the backfill happened to run in. The old values are not
-- recoverable afterwards, so this is a one-way corruption of the ranking signal
-- that nothing would report.
--
-- FIXED AT THE STORAGE LAYER, not at the two call sites. Both the RPC below and
-- the backfill's PostgREST PATCH trip the same trigger, and so would any future
-- writer — a rule each caller has to remember is a rule that gets forgotten
-- exactly once.
--
-- `set_updated_at` itself is LEFT ALONE: five other tables share it
-- (`user_limits`, `orgs`, `org_limits`, `plans`, `user_plans`), and none of them
-- has an embedding column or this problem. Only the `memories` trigger is
-- retargeted.
--
-- The predicate is "did anything OTHER than the embedding columns change?",
-- asked by masking those columns plus `updated_at` and comparing the whole rows.
-- Column-complete by construction: a column added to `memories` later is
-- included automatically, where an explicit list would silently stop covering it.
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_memories_set_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_new memories := new;
  v_old memories := old;
begin
  -- Mask the derived columns and the one being decided.
  v_new.embedding := null; v_new.embedding_model := null; v_new.updated_at := null;
  v_old.embedding := null; v_old.embedding_model := null; v_old.updated_at := null;

  if v_new is not distinct from v_old then
    -- Nothing the user can see changed: an embedding-only write (or a no-op).
    -- Preserve the row's real recency rather than restamping it.
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;

  return new;
end;
$$;

create or replace trigger memories_updated_at
  before update on memories
  for each row execute function lorekit_memories_set_updated_at();

comment on function lorekit_memories_set_updated_at() is
  'BEFORE UPDATE on memories: bumps updated_at like set_updated_at, EXCEPT when the only change is '
  'the embedding columns — a derived artefact must not rewrite the recency signal that search, '
  'relevant, the keyset index and lesson-rank all read. A whole-store backfill would otherwise '
  'restamp every row in created_at desc order, irrecoverably.';

-- ═════════════════════════════════════════════════════════════════════════
-- PART 2 — the authorised write path itself.
-- ═════════════════════════════════════════════════════════════════════════

-- Dropped first for the reason 00019/00009 give: `create or replace` cannot
-- change a function's RETURN TYPE, so amending this later (a third output
-- column, say) would fail against a database that already has it. Forward-only.
drop function if exists lorekit_memory_set_embedding(uuid, uuid, text, text);

create function lorekit_memory_set_embedding(
  p_memory_id     uuid,
  p_actor_user_id uuid,
  p_embedding     text,
  p_model         text
)
returns table (written boolean)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_actor   uuid;
  v_is_svc  boolean;
  v_user_id uuid;
  v_org_id  uuid;
  v_rows    integer;
begin
  if p_memory_id is null then
    return query select false;
    return;
  end if;

  -- Both-or-neither, per the 00060 CHECK. Refused here so the caller gets a
  -- named reason rather than an opaque constraint violation surfacing from a
  -- background task. `embedOnWrite` always sends both; this is the guard for
  -- the next caller.
  if (p_embedding is null) <> (p_model is null) then
    raise exception using
      errcode = 'P0001',
      message = 'embedding and embedding_model must be set together (00060 pairing)';
  end if;

  v_actor  := lorekit_org_actor(p_actor_user_id);
  v_is_svc := auth.role() = 'service_role';

  select m.user_id, m.org_id into v_user_id, v_org_id
    from memories m
   where m.id = p_memory_id;

  -- No such row (deleted between the write and this call). Not an error: the
  -- caller's contract is "never fail a memory write because of an embedding".
  if not found then
    return query select false;
    return;
  end if;

  if v_org_id is not null then
    -- Org-owned. Membership alone is NOT enough — the same 'write' capability
    -- 00019 required to create the row is required to embed it. A null actor
    -- fails closed here (`lorekit_org_role(null, …)` is null), so the service
    -- tier is admitted by its own branch rather than by an accident of NULL
    -- comparison.
    if not (v_is_svc and v_actor is null)
       and not lorekit_org_can(v_actor, v_org_id, 'write') then
      return query select false;
      return;
    end if;

  elsif v_user_id is not null then
    -- Personal. `is distinct from` rather than `<>` so a null actor is a
    -- mismatch instead of an unknown that falls through.
    if v_actor is distinct from v_user_id then
      return query select false;
      return;
    end if;

  else
    -- Neither user- nor org-owned: written by the service tier with
    -- `p_user_id => null`. Only the service tier may touch it.
    if not v_is_svc then
      return query select false;
      return;
    end if;
  end if;

  update memories
     set embedding       = p_embedding::vector(1536),
         embedding_model = p_model
   where id = p_memory_id;

  get diagnostics v_rows = row_count;
  return query select v_rows > 0;
end;
$$;

-- THE REVOKE IS LOAD-BEARING, not belt-and-braces: Postgres grants EXECUTE on a
-- newly created function to PUBLIC by default, and `anon` inherits it. Naming
-- `authenticated, service_role` in the GRANT alone would NOT withhold it — see
-- the same note in 00041, where `migrations.test.sql`'s anon assertion caught
-- exactly this.
revoke execute on function lorekit_memory_set_embedding(uuid, uuid, text, text) from public;
grant  execute on function lorekit_memory_set_embedding(uuid, uuid, text, text)
  to authenticated, service_role;

comment on function lorekit_memory_set_embedding(uuid, uuid, text, text) is
  'Writes memories.embedding + embedding_model for one row, authorised inside the function '
  '(lorekit_org_actor + lorekit_org_can for org-owned rows, actor identity for personal rows). '
  'Returns true when a row was written, false when none matched — the write path records that '
  'miss on its span rather than dropping the embedding silently, which is what rls_update did '
  'for org-owned memories before 00062.';
