-- Repo-scoped webhook secrets.
--
-- Problem: the original webhook_secrets model (00005) is one active secret
-- per user, matched at lookup time by the GitHub *owner login*. That breaks
-- for org-owned repos (repository.owner.login is the org, not the LoreKit
-- user's personal GitHub login) and requires an O(all-users) listUsers scan.
--
-- Fix: add a nullable `repo` column (canonical lowercased `owner/name`) so a
-- user can register a secret per repository, matched deterministically by
-- the delivery's `repository.full_name` — no auth.users join needed.
--
-- Existing null-`repo` rows are kept as-is (a legacy/global fallback secret)
-- for back-compat; this migration does not backfill or touch 00005.
-- Forward-only per CLAUDE.md — never edit an applied migration.

alter table webhook_secrets add column if not exists repo text;

-- Canonical owner/name, lowercased. Null = legacy/global fallback row.
alter table webhook_secrets
  add constraint webhook_secrets_repo_format
  check (repo is null or repo ~ '^[a-z0-9._-]+/[a-z0-9._-]+$');

-- One active secret per (user, repo). coalesce(repo, '') folds the legacy
-- null-repo row into a single active row per user, portably — no
-- NULLS NOT DISTINCT dependency (PG15+-only, and the repo's local Supabase
-- PostgREST predates it per the CI split note in CLAUDE.md).
drop index if exists webhook_secrets_user_active_idx;
create unique index webhook_secrets_user_repo_active_uidx
  on webhook_secrets (user_id, coalesce(repo, ''))
  where active = true;

-- Edge lookup path: match active secrets by repo directly.
create index webhook_secrets_repo_active_idx
  on webhook_secrets (repo)
  where active = true and repo is not null;
