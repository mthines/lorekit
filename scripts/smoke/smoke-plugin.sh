#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Plugin install smoke test.
#
# Proves the lorekit-claude marketplace plugin installs and enables end-to-end
# via the real `claude` CLI — the same flow a user runs locally:
#
#   1. `claude plugin validate`        manifest is well-formed
#   2. skill sync --check              vendored skill matches its source
#   3. marketplace add → install       the marketplace resolves + installs
#   4. `claude plugin list`            the plugin is present AND enabled
#   5. hook engine smoke               the SessionStart hook exits 0 (fail-open)
#
# Requires the `claude` CLI on PATH (CI installs @anthropic-ai/claude-code).
# Idempotent: cleans up the marketplace/plugin it registered, even on failure.
# Run from the repo root:  bash scripts/smoke-plugin.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLUGIN="lorekit-memory"
MARKETPLACE="lorekit"
REF="${PLUGIN}@${MARKETPLACE}"

cleanup() {
  # Best-effort teardown so the runner's user config is left as we found it and
  # local re-runs start clean. Never let cleanup mask the real exit status.
  claude plugin uninstall "$REF" >/dev/null 2>&1 || true
  claude plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! command -v claude >/dev/null 2>&1; then
  echo "::error::claude CLI not found on PATH — cannot run the plugin smoke test"
  exit 1
fi
echo "claude CLI: $(claude --version)"

# 1. Manifest validation.
echo "── validate manifest ─────────────────────────────────────────"
claude plugin validate ./plugins/lorekit-claude

# 2. Vendored skill matches its single source of truth.
echo "── skill sync (--check) ──────────────────────────────────────"
node scripts/sync-plugin-skill.mjs --check

# 3. Register the repo as a marketplace and install from it.
#    Remove any stale registration first so a re-run is deterministic.
echo "── marketplace add + install ─────────────────────────────────"
claude plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 || true
claude plugin marketplace add "$ROOT"
claude plugin install "$REF"

# 4. Assert the plugin is installed AND enabled.
echo "── verify installed + enabled ────────────────────────────────"
LIST="$(claude plugin list 2>&1)"
echo "$LIST"
if ! printf '%s\n' "$LIST" | grep -q "$REF"; then
  echo "::error::$REF not found in \`claude plugin list\`"
  exit 1
fi
# The enabled marker line ("Status: <mark> enabled") follows the plugin entry.
if ! printf '%s\n' "$LIST" | grep -qi 'enabled'; then
  echo "::error::$REF installed but not reported as enabled"
  exit 1
fi

# 5. The SessionStart hook engine runs and fails open (exit 0) with no token.
echo "── hook engine smoke (SessionStart) ─────────────────────────"
echo '{}' | node packages/cli/bin/lorekit.mjs hook --adapter claude --event SessionStart --dir "$ROOT"

echo "✓ plugin smoke passed: $REF installs, enables, and the hook engine runs"
