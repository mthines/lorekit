#!/bin/sh
# Headless sign-in to the LOCAL dashboard as the shared test account.
# Called by environments.yml `local.auth.refresh.command`. The command lives
# here, not inline, because the suite's yaml-lite parser has no block scalars.
# Needs LOREKIT_TESTING_USER_NAME / LOREKIT_TESTING_USER_PW (from .env.local or the shell).
set -a
[ -f .env.local ] && . ./.env.local
[ -f packages/web/.env.local ] && . ./packages/web/.env.local
set +a
AUTH_LOGIN_URL="${PREVIEW_URL:-http://localhost:3000}/login" \
  AUTH_STORAGE_STATE=./.auth/local.json \
  AUTH_POST_LOGIN_URL_PATTERN='/lore' \
  AUTH_AUTHED_ROLE='link' \
  AUTH_AUTHED_NAME='User settings for' \
  node scripts/auth-bootstrap-credentials.mjs
