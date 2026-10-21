#!/bin/sh
# supabase-local.sh — aw-verify's `supabase` component. LOCAL MACHINE ONLY.
#
# 1. Refuses with exit 78 when no Docker daemon or Supabase CLI is reachable —
#    the Agent0 / cloud sandbox has no Docker socket — or AW_LOCAL_SUPABASE=off.
#    The run then carries on with `web` against the hosted backend.
# 2. `supabase start` (idempotent): Postgres, Auth, Studio on 54321-54324.
# 3. Seeds the LoreKit test account (LOREKIT_TESTING_USER_NAME / _PW, from the
#    shell or .env.local) into the LOCAL auth, so the same login works here.
# 4. Serves the Edge Functions (`supabase functions serve`) and, once
#    /functions/v1/health answers, marks the stack ready for web.sh.
#
# This process lives as long as the functions server. Stopping its process
# group stops the functions server and clears the marker; the containers keep
# running until `pnpm nx stop supabase`.
set -eu

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
API=http://127.0.0.1:54321
MARKER="$ROOT/.supabase/aw-local-mode"   # .supabase/ is gitignored

refuse() {
  echo "aw: local Supabase skipped ($1). It runs on a developer machine only, never in the Agent0 sandbox; verify supabase/** changes on the PR preview instead." >&2
  exit 78
}

[ "${AW_LOCAL_SUPABASE:-auto}" = off ] && refuse "AW_LOCAL_SUPABASE=off"
command -v docker >/dev/null 2>&1 || refuse "no docker CLI"
docker info >/dev/null 2>&1 || refuse "no reachable Docker daemon"
command -v supabase >/dev/null 2>&1 || refuse "no Supabase CLI: https://supabase.com/docs/guides/cli"

# Another run's server is still up: reuse it rather than start a second one.
if [ -f "$MARKER" ] && kill -0 "$(cut -d' ' -f1 "$MARKER")" 2>/dev/null; then
  echo "aw: local Supabase already served by pid $(cut -d' ' -f1 "$MARKER") — reusing it"
  exit 0
fi

mkdir -p "$(dirname "$MARKER")"
echo "$$ booting" > "$MARKER"
FN_PID=
cleanup() {
  rm -f "$MARKER"
  [ -n "$FN_PID" ] && kill "$FN_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' INT TERM

supabase start

# Seed the test account. The subshell keeps .env.local's production SUPABASE_*
# values away from everything else; the seeder gets the local API explicitly.
SERVICE_KEY=$(supabase status -o json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const j = JSON.parse(s); process.stdout.write(j.SERVICE_ROLE_KEY || j.SECRET_KEY || j.service_role_key || j.Secret || ""); }
    catch { /* no key: the seeder below reports it */ }
  });')
(
  set -a
  [ -f .env.local ] && . ./.env.local
  [ -f packages/web/.env.local ] && . ./packages/web/.env.local
  set +a
  if [ -z "${LOREKIT_TESTING_USER_NAME:-}" ] || [ -z "${LOREKIT_TESTING_USER_PW:-}" ]; then
    echo "aw: LOREKIT_TESTING_USER_NAME / LOREKIT_TESTING_USER_PW unset — test account not seeded; authed specs cannot sign in locally" >&2
    exit 0
  fi
  SUPABASE_URL="$API" \
    SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY" \
    SUPABASE_ANON_KEY= \
    LOREKIT_SMOKE_EMAIL="$LOREKIT_TESTING_USER_NAME" \
    LOREKIT_SMOKE_PASSWORD="$LOREKIT_TESTING_USER_PW" \
    node scripts/smoke/seed-smoke-user.mjs
) || echo "aw: seeding the test account into the local stack failed — authed specs cannot sign in locally" >&2

supabase functions serve &
FN_PID=$!

i=0
until curl -fsS -o /dev/null --max-time 3 "$API/functions/v1/health"; do
  kill -0 "$FN_PID" 2>/dev/null || { echo "aw: supabase functions serve exited before it was healthy" >&2; exit 1; }
  i=$((i + 1))
  [ "$i" -gt 90 ] && { echo "aw: edge functions not healthy after 180s" >&2; exit 1; }
  sleep 2
done

echo "$$ ready" > "$MARKER"
echo "aw: local Supabase ready — API $API, Studio http://127.0.0.1:54323"
wait "$FN_PID"
