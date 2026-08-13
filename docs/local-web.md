# Local web dev mode

`lorekit serve` (alias `lorekit web`) runs the LoreKit dashboard **locally,
against your local `.lorekit/` (+ `~/.lorekit/`) file store** — no Supabase
project, no hosted account, no network required. It is one command:

```bash
npx @lorekit/cli serve
```

This starts a zero-dependency `node:http` REST shim over your local store,
launches the dashboard pointed at it, prints both URLs, and opens your
browser. Press <kbd>Ctrl-C</kbd> to stop both.

## What works locally

The **Lore Explorer + scope tree**: list, filter (labels, agent, trigger,
kind, host, repo, branch, PR), search, the scope tree, the filter menu's
drill-down counts, the contribution heatmap, and viewing, editing, archiving,
and restoring one lesson — read **and** write, straight to your `.lorekit/*.md`
files.

**Out of scope for local mode** (unchanged if you use the hosted dashboard
instead): the Overview analytics page (usage cards, read-activity), full-text
search (`POST /memories/search` — the Explorer's own `?q=` substring filter
still works), and every org/invite/token/audit-log surface, none of which has
a local-file equivalent.

## How it works

The dashboard is, by design, a client of LoreKit's REST API — it never
queries a database directly (see the root `CLAUDE.md`'s "Data access goes
through a REST endpoint" rule). `lorekit serve` exploits that: it points the
dashboard's `NEXT_PUBLIC_SUPABASE_URL` at a small local server
(`packages/cli/src/serve/`) that implements the same `/memories/*` routes
over your local store instead of Postgres, and gates the dashboard's own
Supabase-Auth session check with a strictly-scoped `LOCAL_MODE` flag so it
never asks a real auth server for a session that doesn't exist. React Query's
caching, optimistic archive/restore, and invalidation all keep working
exactly as they do against the hosted backend — the dashboard's hooks,
queries, and components are completely unaware which transport they are
talking to.

Because there is no real Supabase project locally, there is no real user, JWT,
or row-level security either: the shim accepts any (or no) `Authorization`
header as one implicit local user. This is a *development* mode for browsing
and editing your own lore, not a multi-user or network-exposed server — it
only ever binds to `127.0.0.1`.

Ids are synthesized (a deterministic hash of `scope::key`, not stored on disk)
so `GET /memories/:id`, editing a lesson, and the dashboard's `?memoryId=`
deep links all resolve correctly across restarts.

**This is not part of [Bring Your Own Database](./byod.md).** BYOD points the
*same* Deno edge handlers at a Postgres database you control — same code, same
schema, different database. Local web dev mode is a different *runtime*
entirely (a Node process, no handlers, a markdown file store) that shares only
the `@lorekit/schemas` request/response contract with the hosted API. The two
are not merged and are not expected to converge.

## Command reference

```bash
lorekit serve [options]
lorekit web [options]        # alias
```

| Option | Default | Meaning |
|---|---|---|
| `-d, --dir <path>` | current directory | Project root whose `.lorekit/` is served |
| `--port <n>` | `4850` | Port for the REST shim (auto-increments if taken) |
| `--web-port <n>` | `4851` | Port for the dashboard (auto-increments if taken) |
| `--dev` | off | Run the dashboard's **source dev server** instead of the prebuilt bundle — for contributors working on this repo |
| `--no-open` | off | Do not open the dashboard URL in a browser |

## The prebuilt bundle (no repo checkout needed)

By default, `lorekit serve` launches a **prebuilt Next.js standalone bundle**
of the dashboard — an end user never needs to clone this repository or run
`pnpm install`. The CLI locates it under `~/.lorekit/web/<cli-version>/`
(honouring `$LOREKIT_HOME`) and, on a cache miss, downloads and extracts it
from a version-pinned release asset the first time that CLI version runs
`serve`. Every later run for that version is a pure cache hit — no network.

`--dev` is the contributor path instead: it spawns `packages/web`'s own
`next dev` from a checkout of this repo (needs dependencies installed).

### Building and publishing the bundle

`scripts/build-web-bundle.mjs` builds `packages/web` with `output: 'standalone'`
and `NEXT_PUBLIC_LOREKIT_LOCAL_MODE=1` baked in (the **one** build that ever
sets that flag — the Vercel production build never does, which is what keeps
the local-mode branch out of the hosted bundle entirely), assembles Next's
documented standalone layout (copying `.next/static` and `public/` in), and
packages the result into a private, zero-dependency archive format (see
`packages/cli/src/serve/bundle-archive.mjs` — not tar or zip, to sidestep
tar's 100-character name limit on a monorepo's deeply nested
`node_modules/.pnpm/...` paths without adding a real dependency):

```bash
node scripts/build-web-bundle.mjs
# writes dist/lorekit-web-standalone-v<cli-version>.lkbundle.gz
```

### Wiring the release upload into CI

This repository's GitHub App has no `workflows` permission, so the following
step has to be added to `.github/workflows/release.yml`'s `publish-cli` job
by a human with write access — it is not wired automatically by this change.
Add it right after the existing npm-publish step, so every `@lorekit/cli`
release also ships the matching bundle:

```yaml
      - name: Build and upload the web bundle
        run: node scripts/build-web-bundle.mjs
      - name: Upload to the release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: cli-v${{ steps.release.outputs.version }}
          files: dist/lorekit-web-standalone-v${{ steps.release.outputs.version }}.lkbundle.gz
```

Until that step is added, `lorekit serve` (no `--dev`) will fail to download a
bundle for a version with no matching release asset — use `--dev` from a repo
checkout, or self-host the artifact and point `LOREKIT_WEB_BUNDLE_URL` at it
(see `packages/cli/src/serve/bundle.mjs`).

## Troubleshooting

- **Port already in use** — `serve` auto-increments past a taken port for
  both the shim and the dashboard; the printed URLs always reflect the port
  actually bound.
- **`--dev` fails immediately** — it needs a checkout of this repo with
  dependencies installed (`pnpm install`); the prebuilt bundle path (the
  default, no `--dev`) does not.
- **Changes made in the dashboard don't show up in `lorekit list`/`lorekit
  show`** — both read the same `.lorekit/` (+ `~/.lorekit/`) files; if they
  disagree, confirm `serve` was started from the directory you expect (`--dir`)
  and that `$LOREKIT_HOME`/`$LOREKIT_STORE` are not overridden differently in
  each shell.
