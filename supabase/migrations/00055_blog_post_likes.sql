-- ═════════════════════════════════════════════════════════════════════════
-- blog_post_likes — a public, anonymous, cumulative "like" counter for /blog.
--
-- WHY this table looks unlike every other one in this schema: the blog is a
-- PUBLIC, statically-generated surface with no auth gate, and a like
-- accumulates across ALL visitors — signed-in or not. So, uniquely here, the
-- read policy and the increment RPC are granted to `anon`. There is no
-- user_id, no tenant, no owner-scoped RLS: the counter is one global total per
-- post slug, exactly like a page-view counter.
--
-- The per-user/session cap (max 100 likes) is enforced CLIENT-side, in
-- localStorage, because an anonymous visitor has no server identity to key a
-- per-session tally on. The server's job is only to (a) accumulate the global
-- total atomically and (b) refuse an obviously abusive single call: the RPC
-- clamps p_delta to [1, 100] and validates the slug shape, so no single request
-- can inflate a counter by more than one session's worth, and no caller can
-- create junk rows under arbitrary keys. A determined client can still script
-- the endpoint — that is inherent to an anonymous public counter and accepted
-- for a blog vanity metric; the clamp bounds the per-call blast radius.
--
-- Writes go ONLY through the SECURITY DEFINER RPC (there is no insert/update
-- RLS policy), so the slug validation and delta clamp cannot be bypassed by a
-- direct PostgREST write. Reads are a plain SELECT under the public policy.
-- ═════════════════════════════════════════════════════════════════════════

create table if not exists blog_post_likes (
  slug       text primary key
             check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and length(slug) <= 128),
  likes      bigint      not null default 0 check (likes >= 0),
  updated_at timestamptz not null default now()
);

alter table blog_post_likes enable row level security;

-- Public read: anyone (signed-in or not) can see the totals. This is the whole
-- point — the count is shown to every blog visitor.
drop policy if exists blog_post_likes_public_read on blog_post_likes;
create policy blog_post_likes_public_read
  on blog_post_likes for select
  to anon, authenticated
  using (true);

-- No insert / update / delete policy is defined on purpose: every write must go
-- through lorekit_blog_like below, so the slug CHECK and the [1,100] delta clamp
-- are always applied.

-- ── lorekit_blog_like(slug, delta) → new global total ──────────────────────
-- Atomic upsert-increment. SECURITY DEFINER so `anon` can accumulate the total
-- without any table-level write grant. Validates the slug and clamps the delta.
create or replace function lorekit_blog_like(p_slug text, p_delta int default 1)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  -- One click is +1; a batched flush of a rapid-tap burst sends its accumulated
  -- delta. Clamp to a single session's worth so no call can inflate the counter
  -- past the client-enforced cap, and floor at 1 so a stray 0/negative is a
  -- no-op increment rather than a silent decrement.
  v_delta int    := least(greatest(coalesce(p_delta, 1), 1), 100);
  v_total bigint;
begin
  if p_slug is null
     or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or length(p_slug) > 128 then
    raise exception 'invalid blog slug %', p_slug using errcode = '22023';
  end if;

  insert into blog_post_likes as l (slug, likes, updated_at)
       values (p_slug, v_delta, now())
  on conflict (slug)
    do update set likes = l.likes + v_delta, updated_at = now()
  returning l.likes into v_total;

  return v_total;
end;
$$;

revoke execute on function lorekit_blog_like(text, int) from public;
grant  execute on function lorekit_blog_like(text, int) to anon, authenticated, service_role;

comment on table blog_post_likes is
  'Public, anonymous, cumulative like counter for /blog posts — one global total
   per post slug. No user_id/tenant: reads are public and writes go only through
   lorekit_blog_like. The per-session 100-like cap is enforced client-side.';

comment on function lorekit_blog_like(text, int) is
  'Atomically add p_delta (clamped to [1,100]) likes to a blog post and return
   the new global total. SECURITY DEFINER + granted to anon so an unauthenticated
   blog visitor can like a post. Validates the slug shape (lowercase kebab, <=128)
   so no junk rows can be created.';
