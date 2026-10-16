# Bring Your Own Database (BYOD)

BYOD stores memories in a Supabase project you control, separate from the
project that runs LoreKit's `mcp` Edge Function. Use it when memory rows must
live in a specific database — data residency, an existing Supabase
subscription, or full control over the data.

It covers the MCP server's tools. Read [How BYOD is wired](#how-byod-is-wired)
before setting it up: what reaches the storage project, and what does not, is
the part most likely to surprise you.

## How BYOD is wired

- **It needs your own deployment of the `mcp` function.** The function reads
  `LOREKIT_STORAGE_URL`, `LOREKIT_STORAGE_ANON_KEY` and the optional
  `LOREKIT_STORAGE_SERVICE_KEY` from its **own Edge Function secrets**. The
  hosted endpoint (`https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp`)
  has no BYOD storage configured, and an `env` block in your `.mcp.json` does
  not reach it — those variables only reach the local `mcp-remote` process on
  your machine. Deploy the function yourself first: [install.md](./install.md).
- **Two projects, two jobs.** API tokens and users are resolved in the
  function's own project; memory rows are read from and written to the
  storage project. The storage project's `auth.users` never holds those users,
  which is why the storage schema drops its foreign keys into `auth.users`
  (step 2).
- **Only the `mcp` function has a BYOD mode.** The `memories` REST function —
  which backs the web dashboard, the CLI's remote commands and the hook
  engine's lesson injection — always uses the function's own project. See
  [Limitations](#limitations).

## Setup

### 1. Create the storage project

Create a project at [supabase.com](https://supabase.com). Note its URL and API
keys (**Project Settings → API**) and its database connection string
(**Connect**). Enable the `pg_cron` extension (**Database → Extensions**)
before applying the schema: the purge jobs are scheduled only when it is
already enabled.

### 2. Apply the LoreKit schema

The storage project needs the full LoreKit schema — the same migrations the
hosted project runs. Pick one route.

**Supabase CLI (recommended — the same commands upgrade it later):**

```bash
git clone https://github.com/mthines/lorekit.git
cd lorekit
supabase link --project-ref <storage-project-ref>
supabase db push
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/byod/storage-overlay.sql
```

The last line applies the **storage overlay**: it drops every foreign key from
a `public` table into `auth.users`, because the users live in the function's
project, not this one. Without it, every write made with an `lk_*` token fails
with `memories_user_id_fkey`. It is idempotent; re-run it after every
`db push`. Never apply it to the project that runs the `mcp` function.

**One SQL file (empty database only):**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/byod/bootstrap.sql
```

or paste [`supabase/byod/bootstrap.sql`](https://github.com/mthines/lorekit/blob/main/supabase/byod/bootstrap.sql)
into the Supabase dashboard → **SQL Editor** and run it (the file is about 1 MB;
if the editor refuses it, use `psql`). `$DATABASE_URL` is the connection string
from **Connect**; its password is your **database password**, not an API key.

`bootstrap.sql` is generated from `supabase/migrations/` (CI fails when the two
disagree) and ends with the storage overlay. It applies everything in one
transaction, so a failure leaves the database untouched; it refuses to run
against a database that already has the schema; and it records each migration
in Supabase's migration history, so the CLI route above upgrades the database
later.

`lorekit bootstrap`, run with `LOREKIT_STORAGE_URL` and a key in your shell,
checks whether the project is reachable and already has the schema, and prints
these commands. It does not run any DDL itself — a Supabase API key cannot.

### 3. Point your `mcp` function at it

Set the storage secrets on the project that runs your `mcp` function:

```bash
supabase secrets set --project-ref <function-project-ref> \
  LOREKIT_STORAGE_URL=https://<storage-project-ref>.supabase.co \
  LOREKIT_STORAGE_ANON_KEY=<storage-anon-key> \
  LOREKIT_STORAGE_SERVICE_KEY=<storage-service-role-key>
```

The service key is **required**: without it, every call to the function fails
with an error naming `LOREKIT_STORAGE_SERVICE_KEY`. The storage project's read policies need `auth.uid()`, which an API
key never carries, so an anon-key client could write but would read back
nothing. `LOREKIT_STORAGE_ANON_KEY` is accepted but unused once the service key
is set.

The service key bypasses row-level security, so the function scopes every call
itself: reads and writes made with an `lk_*` token, or from a Supabase session,
are filtered to and stamped with that caller's user id. Only the service-role
tier (CI) sees every row.

### 4. Check it

```bash
LOREKIT_STORAGE_URL=https://<storage-project-ref>.supabase.co \
LOREKIT_STORAGE_ANON_KEY=<storage-anon-key> \
lorekit doctor
```

The `byod storage` line passes when the project is reachable and holds the
schema. It fails when the project is unreachable, rejects the key, or does not
have the schema yet, and says which.

## Upgrading

When a LoreKit release adds migrations, upgrade the storage project from a
checkout of that release:

```bash
supabase link --project-ref <storage-project-ref>
supabase db push
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/byod/storage-overlay.sql
```

`db push` applies only the migrations the database has not recorded, which
works the same whether you set the database up with `db push` or with
`bootstrap.sql`. Re-run the overlay after it, in case a new migration added a
foreign key into `auth.users`. Upgrade the storage project before deploying the
matching `mcp` function: the function calls the RPCs those migrations define.

### Databases set up from the old `bootstrap.sql`

`bootstrap.sql` used to be a hand-written subset of the schema. A database set
up from that version has no migration history — `select count(*) from
supabase_migrations.schema_migrations` errors or returns 0 — so `db push` would
try to replay every migration from the first and fail, and its schema is
missing most of the functions the current `mcp` function calls. Move to a
fresh storage project instead: apply the current schema to it as above, copy the `memories`
rows across (for example `pg_dump --data-only --table=public.memories` from the
old database, loaded with `psql` into the new one), then point
`LOREKIT_STORAGE_URL` at the new project.

## Billing

Memories stored in your own database are **not counted** against LoreKit's
hosted memory-count billing. LoreKit has no visibility into your private
database and cannot meter memories stored there.

The memory cap (default 5,000 active memories per user) and the limits table
live in your database: adjust them through `lorekit_default_limit` and
`user_limits` there. In BYOD mode the function skips the hosted rate limiter
and does not record hosted usage events.

## Limitations

- **Only the MCP tools use the storage project.** The web dashboard, the REST
  API, the CLI's remote commands (`list`, `search`, `show`, `write` against the
  remote store) and the hook engine's lesson injection go through the `memories`
  function, which has no BYOD mode. They read and write the function's own
  project and do not see memories stored through BYOD. To run the dashboard on
  a database you control, self-host the whole stack instead
  ([install.md](./install.md)).
- **No row-level security in the storage project.** The function talks to it
  with the service key and scopes every call in its own code (step 3); RLS
  policies there do not apply to it.
- **Tested surface.** The BYOD smoke test exercises write, read, list, search
  and delete, and runs only where its secrets are configured. The schema now
  also contains the org, audit, retention and webhook tables and RPCs, but BYOD
  has not been exercised for those features — treat them as unsupported.
