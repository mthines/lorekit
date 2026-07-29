# Bring Your Own Database (BYOD)

LoreKit's memory tools can point at a Supabase project you control instead of
the hosted LoreKit backend. This is useful when you have data residency
requirements, an existing Supabase subscription, or want full control over
your memory data.

## Setup

### 1. Create a Supabase project

Create a free project at [supabase.com](https://supabase.com). Note your
project URL and API keys from **Settings → API**.

### 2. Apply the LoreKit schema

Run the bootstrap command to create the required tables and functions:

```bash
LOREKIT_STORAGE_URL=https://your-project.supabase.co \
LOREKIT_STORAGE_SERVICE_KEY=your-service-role-key \
lorekit bootstrap
```

Or apply the SQL file directly:

```bash
psql "$DATABASE_URL" -f node_modules/@lorekit/cli/supabase/byod/bootstrap.sql
```

### 3. Configure your MCP server

In your `.mcp.json` or equivalent MCP config, add the env vars:

```json
{
  "env": {
    "LOREKIT_STORAGE_URL": "https://your-project.supabase.co",
    "LOREKIT_STORAGE_ANON_KEY": "your-anon-key"
  }
}
```

Or set them in your shell before starting the MCP server.

## Billing

Memories stored in your own database are **not counted** against LoreKit's
hosted memory-count billing. LoreKit has no visibility into your private
database and cannot meter memories stored there.

BYOD users are on a flat-rate or open-source tier — no per-memory billing.

You are responsible for configuring memory limits and rate limiting in your
own Supabase project. The bootstrap schema ships with a default 5,000-memory
cap trigger, which you can adjust by editing the `lorekit_default_limit`
function in your database.

## Limitations

The following LoreKit features are **not available** with BYOD:

- **Org/scope sharing** — requires the hosted backend's org management RPCs
- **Web dashboard** — tightly coupled to hosted Supabase Auth
- **Audit logs** — not included in the BYOD schema
- **Webhook secrets** — not included in the BYOD schema
- **Automatic schema upgrades** — when LoreKit ships schema changes, you
  must apply them manually. Run `lorekit doctor` to check compatibility.

## Checking connectivity

```bash
LOREKIT_STORAGE_URL=https://your-project.supabase.co \
LOREKIT_STORAGE_ANON_KEY=your-anon-key \
lorekit doctor
```

The output will include a `[byod] storage ok` line if the database is reachable.
