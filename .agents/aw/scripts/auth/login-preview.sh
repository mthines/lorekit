#!/bin/sh
# Headless sign-in to a PR PREVIEW as the shared test account.
# Called by environments.yml `preview.auth.refresh.command` (see login-local.sh
# for why this is a file). The runner exports PREVIEW_URL.
set -a
[ -f .env.local ] && . ./.env.local
[ -f packages/web/.env.local ] && . ./packages/web/.env.local
set +a
: "${PREVIEW_URL:?PREVIEW_URL is set by the runner to the resolved preview origin}"
AUTH_LOGIN_URL="$PREVIEW_URL/login" \
  AUTH_STORAGE_STATE=./.auth/preview.json \
  AUTH_POST_LOGIN_URL_PATTERN='/lore' \
  AUTH_AUTHED_ROLE='link' \
  AUTH_AUTHED_NAME='User settings for' \
  node scripts/auth-bootstrap-credentials.mjs
