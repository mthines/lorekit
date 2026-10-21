#!/bin/sh
# web.sh — aw-verify's `web` component: the dashboard on http://localhost:3000.
#
# Backend, decided once at start:
#   local   supabase-local.sh is running (its marker names a live pid) → wait for
#           it to report ready, then `nx serve-local web`
#           (NEXT_PUBLIC_USE_LOCAL_SUPABASE=true → http://127.0.0.1:54321).
#   hosted  otherwise → `nx serve web` with the Supabase project in .env.local,
#           which is PRODUCTION (pqokxlhvnosogizsjztg). See .agents/aw/notes.md.
# AW_WEB_BACKEND=local|hosted forces one.
set -eu

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
MARKER="$ROOT/.supabase/aw-local-mode"

marker_live() {
  [ -f "$MARKER" ] && kill -0 "$(cut -d' ' -f1 "$MARKER")" 2>/dev/null
}

mode=${AW_WEB_BACKEND:-auto}
if [ "$mode" = auto ]; then
  mode=hosted
  if marker_live; then
    i=0
    # supabase-local.sh may still be seeding or booting the functions server.
    while marker_live && [ "$(cut -d' ' -f2 "$MARKER" 2>/dev/null)" != ready ]; do
      i=$((i + 1))
      [ "$i" -gt 120 ] && break
      sleep 2
    done
    marker_live && [ "$(cut -d' ' -f2 "$MARKER")" = ready ] && mode=local
  fi
fi

case "$mode" in
  local)
    echo "aw: web → local Supabase (http://127.0.0.1:54321)"
    exec pnpm nx serve-local web
    ;;
  hosted)
    echo "aw: web → hosted Supabase from .env.local (production)"
    exec pnpm nx serve web
    ;;
  *)
    echo "aw: AW_WEB_BACKEND must be local or hosted, got '$mode'" >&2
    exit 64
    ;;
esac
