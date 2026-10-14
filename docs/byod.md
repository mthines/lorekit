# Bring Your Own Database (BYOD)

BYOD stores memories in a Supabase project you control, separate from the
project that runs LoreKit's `mcp` Edge Function. Use it when memory rows must
live in a specific database — data residency, an existing Supabase
subscription, or full control over the data.

It covers the `memory.*` MCP tools. Read [How BYOD is wired](#how-byod-is-wired)
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
  storage project.
- **Only the `mcp` function has a BYOD mode.** The `memories` REST function —
  which backs the web dashboard, the CLI's remote commands and the hook
  engine's lesson injection — always uses the function's own project. See
  [Limitations](#limitations).

## Setup

### 1. Create the storage project

Create a project at [supabase.com](https://supabase.com). Note its URL and API
keys (**Project Settings → API**) and its database connection string
(**Connect**).

### 2. Apply the LoreKit schema

The storage project needs the full LoreKit schema — the same migrations the
hosted project runs. Pick one route.

**Supabase CLI (recommended — the same command upgrades it later):**

```bash
git clone https://github.com/mthines/lorekit.git
cd lorekit
supabase link --project-ref <storage-project-ref>
supabase db push
```

**One SQL file (empty database only):**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/byod/bootstrap.sql
```

or paste [`supabase/byod/bootstrap.sql`](https://github.com/mthines/lorekit/blob/main/supabase/byod/bootstrap.sql)
into the Supabase dashboard → **SQL Editor** and run it. `$DATABASE_URL` is the
connection string from **Connect**; its password is your **database password**,
not an API key.

`bootstrap.sql` is generated from `supabase/migrations/` (CI fails when the two
disagree). It applies every migration in one transaction, so a failure leaves
the database untouched; it refuses to run against a database that already has
the schema; and it records each migration in Supabase's migration history, so
the CLI route above upgrades the database later.

`lorekit bootstrap`, run with `LOREKIT_STORAGE_URL` and a key in your shell,
checks whether the project is reachable and already has the schema, and prints
these commands. It does not run any DDL itself — a Supabase API key cannot.

### 3. Point your `mcp` function at it

Set the storage secrets on the project that runs your `mcp` function:

```bash
supabase secrets set --project-ref <function-project-ref> \
  LOREKIT_STORAGE_URL=https://<storage-project-ref>.supabase.co \
  LOREKIT_STORAGE_ANON_KEY=<storage-anon-key>
```

`LOREKIT_STORAGE_SERVICE_KEY` is optional. When it is set, the function uses it
instead of the anon key, and it **bypasses row-level security** in the storage
project: data isolation then rests on the `user_id` filters the function
applies, not on RLS policies.

### 4. Check it

```bash
LOREKIT_STORAGE_URL=https://<storage-project-ref>.supabase.co \
LOREKIT_STORAGE_ANON_KEY=<storage-anon-key> \
lorekit doctor
```

The `byod storage` line passes when the project is reachable and holds the
schema, and says so when the schema has not been applied yet.

## Upgrading

When a LoreKit release adds migrations, upgrade the storage project from a
checkout of that release:

```bash
supabase link --project-ref <storage-project-ref>
supabase db push
```

`db push` applies only the migrations the database has not recorded, which
works the same whether you set the database up with `db push` or with
`bootstrap.sql`. Upgrade the storage project before deploying the matching
`mcp` function: the function calls the RPCs those migrations define.

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
  project and do not see memories stored through BYOD.
- **A token's user must also exist in the storage project.** `memories.user_id`
  references the storage project's `auth.users`. A write made with an `lk_*`
  token carries the token owner's id from the function's project, and it fails
  with `memories_user_id_fkey` unless a user with that id also exists in the
  storage project. Writes made with the service-role key carry no user id and
  are not affected.
- **No per-user RLS in the storage project.** The function talks to it with the
  service or anon key, never with the caller's JWT.
- **Tested surface.** The BYOD smoke test covers write, read, list, search and
  delete across the four scope types. The schema now also contains the org,
  audit, retention and webhook tables and RPCs, but BYOD has not been exercised
  for those features — treat them as unsupported.
