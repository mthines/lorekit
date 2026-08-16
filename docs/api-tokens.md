# API Tokens

LoreKit uses durable API tokens for agent and CI authentication. Tokens are generated in the web dashboard and never expire unless revoked.

## Token format

```
lk_{perm}_{32 random alphanumeric chars}
```

| Prefix | Permissions | Example |
|--------|-------------|---------|
| `lk_rw_` | Read + Write | `lk_rw_aBcDeFgH1234...` |
| `lk_ro_` | Read only | `lk_ro_xYzAbCdE5678...` |
| `lk_wo_` | Write only | `lk_wo_mNoPqRsT9012...` |

The prefix encodes the permission so it's visible in config files at a glance.

Tokens are stored as **SHA-256 hashes** in the database. The full token is shown once on creation and cannot be retrieved again — treat it like a password.

## Generating a token

1. Go to the LoreKit dashboard → **Overview**
2. Expand **Step 2: Connect your agent**
3. Click **Generate new token**
4. Enter a name (e.g. `aw-executor`, `ci-github-actions`, `local-dev`)
5. Choose **Read + Write**, **Read only**, or **Write only**
6. Copy the token from the amber banner — it won't be shown again

## Scoping a token

Beyond read/write, a token can be narrowed to **specific scopes** and to a
**specific tenancy**. Both are optional and both default to unrestricted, so a
token you never scope behaves exactly as it always has.

| Axis | Column | Default | Meaning |
|------|--------|---------|---------|
| Scopes | `api_tokens.scopes` | `{}` — **unrestricted** | Allowlist of scope patterns the token may touch |
| Tenancy | `api_tokens.org_access` | `all` | `all` \| `personal` \| `selected` |
| Orgs | `api_tokens.org_ids` | `{}` | The orgs a `selected` token may reach |

### Scope patterns

A pattern is either a canonical scope or an **owner wildcard** ending in `*` —
the same shape the `?scope=` search filter accepts:

```
repo::mthines/lorekit      exactly that repo
repo::mthines/*            every repo under that owner
global                     the global scope
```

Patterns are OR-ed: a token allowing `["global", "repo::mthines/*"]` reaches
either. An **empty** allowlist reaches everything the owner can see. At most 50
patterns per token, each at most 200 characters, over the charset
`[a-z0-9._:/-]` with an optional trailing `*`.

An **interior** wildcard (`repo::*/lorekit`) is not supported.

### Tenancy

| `org_access` | Personal memories | Org memories |
|--------------|-------------------|--------------|
| `all` (default) | ✓ | Every org the owner belongs to |
| `personal` | ✓ | None |
| `selected` | ✓ | Only the orgs in `org_ids` |

Personal memories are reachable under every tenancy — `personal` narrows which
*orgs* a token reaches, it never revokes the owner's own memories. A token can
only be pointed at an org its **owner** is a member of; asking for any other org
is rejected when the scoping is saved, not silently ignored.

Tenancy is authoritative over
[scope→org binding](./decisions.md#scopeorg-binding): a write under a bound
scope from a `personal` token falls back to a personal memory rather than being
routed into an org the token was never granted.

### What a scoped token sees

| Situation | Behaviour |
|-----------|-----------|
| The request NAMES a scope outside the allowlist | Refused — MCP returns the `-32003` forbidden error, REST returns `403`. A named scope gets a plain refusal rather than an empty page, which would read as "there is nothing there". |
| The request names NO scope (`memory.list` unfiltered, `GET /memories`) | Narrowed. Only rows inside the allowlist and the tenancy come back. |
| The per-scope aggregates called WITHOUT a scope — `memory.scopes` / `GET /memories/scopes`, `GET /memories/tags`, `/facets`, `/activity` and `/read-activity` | Narrowed, inside their RPCs. A scope string is a repo or project name, and the `origin_repo` facet is one outright, so an unfiltered catalog would leak exactly what scoping hides — and narrowing only some of these would move the leak rather than close it. A read whose scope could not be attributed names nothing and still counts toward the total. `GET /memories/usage` is not in this list: it rolls up by `scope_type` (`repo`, `project`, `global`), never a name. |
| The three aggregates that accept `?scope=` — `/activity`, `/read-activity`, `/facets` — called WITH one | Refused with a `403`, like any other named scope. The row above is the no-scope-named case; naming a scope the token may not reach must not answer with an empty series, which reads as "there was no activity". |
| An account-wide sweep (`memory.purge`, `memory.purge_expired`, and their REST twins `POST /memories/purge` and `/purge-expired`) | Refused for a token WITH a scope allowlist, on both surfaces; unaffected for one without. There is no scope to check and no result set to narrow — the rows are chosen inside the RPC — so the only available answer is to refuse the call. Use an unscoped token for maintenance sweeps. |
| A write addressed BY ID (`PATCH`/`DELETE`/restore) | Filtered by the allowlist. These are personal-only and never widen to org rows, so they narrow on the allowlist alone rather than through the tenant predicate. The forms that NAME a scope (`DELETE ?scope=…&key=…`, with or without `&org=`, and the `POST /memories/restore` body form) are refused with a `403` instead, like any other named scope. |
| The token is unscoped (the default) | Nothing changes, on any path. |

## Permission matrix

| Tool | Read + Write (`lk_rw_`) | Read only (`lk_ro_`) | Write only (`lk_wo_`) |
|------|------------------------|---------------------|------------------------|
| `memory.write` | ✓ | ✗ (returns -32001) | ✓ |
| `memory.read` | ✓ | ✓ | ✗ (returns -32001) |
| `memory.list` | ✓ | ✓ | ✗ (returns -32001) |
| `memory.delete` | ✓ | ✗ (returns -32001) | ✓ |
| `memory.search` | ✓ | ✓ | ✗ (returns -32001) |
| `memory.archive` | ✓ | ✗ (returns -32001) | ✓ |
| `memory.restore` | ✓ | ✗ (returns -32001) | ✓ |
| `memory.purge` | ✓ | ✗ (returns -32001) | ✓ |
| `memory.purge_expired` | ✓ | ✗ (returns -32001) | ✓ |
| `memory.list_archived` | ✓ | ✓ | ✗ (returns -32001) |

## Using a token

Pass the token as a Bearer header:

```bash
curl -X POST https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer lk_rw_<your-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory.list","arguments":{"scope":"global"}}}'
```

In `.mcp.json` (via `mcp-remote`):

```jsonc
{
  "mcpServers": {
    "lorekit": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
               "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp",
               "--header", "Authorization:Bearer lk_rw_<your-token>"]
    }
  }
}
```

## CI / GitHub Actions

Use a **read+write** token stored as a GitHub Actions secret:

```yaml
- name: Write lesson to LoreKit
  run: |
    curl -s -X POST "$LOREKIT_MCP_URL" \
      -H "Authorization: Bearer $LOREKIT_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory.write","arguments":{"scope":"repo::${{ github.repository }}","key":"ci-lesson","value":"...","tags":["source::ci"]}}}'
  env:
    LOREKIT_MCP_URL: https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp
    LOREKIT_TOKEN: ${{ secrets.LOREKIT_TOKEN }}
```

## Revoking a token

In the dashboard → Overview → Step 2 → your token list → click the trash icon → confirm. Revocation is immediate.

## Limits

- Maximum 20 tokens per user account.
- Maximum 50 scope patterns and 50 orgs per token.
- No expiry — tokens are valid until revoked.
- `last_used_at` is updated on every successful authentication.
