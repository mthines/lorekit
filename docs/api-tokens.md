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
6. Optionally expand **Scoping** to pick an allowlist of scopes and an organisation access level (see below)
7. Copy the token from the amber banner — it won't be shown again

Scoping can be changed after creation; the permission tier cannot (it is encoded
in the token prefix, which is fixed at generation).

## Scoping a token

> **Enforced.** `00068_api_token_scoping.sql` added the columns and the two
> request-time predicates; `00069_api_token_scoping_enforcement.sql` made them
> binding across all three layers — the transports (`mcp/auth.ts`,
> `_shared/api/auth.ts`, `mcp-handler.ts`, `applyTenantScope` /
> `applyRestTenantScope`, `applyKeyScopeFilter`, `firstDeniedScope`), and the
> mutation gates and per-scope aggregates inside Postgres. Step 6 above is the
> dashboard path that sets them (`TokenManager.tsx`), and
> `00070_audit_log_api_key_scope_change.sql` records every change. An existing
> token you never scope still behaves exactly as it always has — the columns
> default to unrestricted, and every predicate returns "allowed" for that
> default.

Beyond read/write, a token can be narrowed to **specific scopes** and to a
**specific tenancy**. Both are optional and both default to unrestricted, so a
token you never scope behaves exactly as it always has.

| Axis | Column | Default | Meaning |
|------|--------|---------|---------|
| Scopes | `api_tokens.scopes` | `{}` — **unrestricted** | Allowlist of scope patterns the token may touch |
| Tenancy | `api_tokens.org_access` | `all` | `all` \| `personal` \| `selected` |
| Orgs | `api_tokens.org_ids` | `{}` | The orgs a `selected` token may reach |

### Scope patterns

A pattern is either a canonical scope or an **owner wildcard** — the same shape
the `?scope=` search filter accepts:

```
repo::mthines/lorekit      exactly that repo
repo::mthines/*            every repo under that owner
project::*                 every project scope
global                     the global scope
```

Patterns are OR-ed: a token allowing `["global", "repo::mthines/*"]` reaches
either. An **empty** allowlist reaches everything the owner can see. At most 50
patterns per token, each at most 200 characters, over the charset
`[a-z0-9._:/-]`.

The `*` is a wildcard **only as the last character and only directly after a
`/` or a `::`** — the wildcard may replace a whole segment, never part of one.
Both of these are rejected:

```
repo::*/lorekit            an INTERIOR wildcard
repo::mthines/lore*        a trailing `*` off a segment boundary
```

`repo::mthines/lore*` is refused for the same reason `expandScopeForSearch`
refuses it as a search filter: an "any trailing star" rule would let it
allowlist `repo::mthines/lorekit-private`, so the allowlist grammar and the
search grammar would disagree while wearing the same syntax.

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
| The per-scope aggregates — `memory.scopes` / `GET /memories/scopes`, the `GET /memories/activity` and `/read-activity` series, and `GET /memories/tags` and `/facets` | **Unfiltered: narrowed** the same way, inside their RPCs. A scope string is a repo or project name, and the `origin_repo` facet is one outright, so an unfiltered catalog would leak exactly what scoping hides — and narrowing only some of these would move the leak rather than close it. A read whose scope could not be attributed names nothing and still counts toward the total. **With a `?scope=` outside the allowlist: refused with a `403`**, like the row above — narrowing a NAMED scope to an empty series answers "you read nothing there", which is a different statement than "you may not ask". `GET /memories/usage` is not in this list: it rolls up by `scope_type` (`repo`, `project`, `global`), never a name. |
| `GET /memories/relevant` | The same two halves as `GET /memories`: narrowed when it names no scope, and refused with a `403` when any entry of `?scopes=` is outside the allowlist. Every named scope must be allowed — answering over the allowed subset would silently drop a rank from the precedence order the caller expressed. |
| `GET /memories/clusters` | The same two halves as `GET /memories`, and for the same reason it must be: a cluster names its members by `scope` and `key`, so it is as name-bearing as the list itself. Narrowed when it names no scope; refused with a `403` for a `?scope=` outside the allowlist, ahead of the query, so an out-of-allowlist scope cannot come back as "no duplicates there". |
| An account-wide sweep (`memory.purge`, `memory.purge_expired`, their REST twins `POST /memories/purge` and `/purge-expired`, and the `lorekit purge` / `lorekit purge-expired` commands that call them) | Refused for a token WITH a scope allowlist, on every surface; unaffected for one without. There is no scope to check and no result set to narrow — the rows are chosen inside the RPC — so the only available answer is to refuse the call. Use an unscoped token for maintenance sweeps. The CLI prints the server's refusal VERBATIM plus a one-line next step, makes exactly one request, and never retries, splits the sweep or re-scopes to work around it. |
| A write addressed BY ID (`PATCH` update, `DELETE /:id`, `POST /memories/:id/restore`) | Filtered by the allowlist and personal-only — narrowed to the caller's own rows within its scopes, never widened to org rows or another writer's. |
| A removal or restore that NAMES a scope+key (`DELETE ?scope=…&key=…`, the `POST /memories/restore` body form, and the MCP `memory.delete` / `memory.archive` / `memory.restore` tools) | **Scope-authorized.** For a scope INSIDE the allowlist a scoped token may archive / hard-delete / restore **any** writer's row for that `(scope, key)` — the management authority the owner granted by scoping the key — and a 0-row result is reported as `404` (nothing there) rather than `403` (present, but not this token's to touch), so "already gone" and "not yours" stay distinguishable. A scope OUTSIDE the allowlist is refused with a `403`, like any other named scope. An UNSCOPED token is unchanged — own-rows-only. The `&org=` delete form stays role-gated inside its RPC (org membership + write capability), never widened by the scope allowlist. |
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
| `org.list` | ✓ | ✓ | ✗ (returns -32001) |
| `org.create` | ✓ | ✗ (returns -32001) | ✓ |
| `org.rename` | ✓ | ✗ (returns -32001) | ✓ |
| `org.delete` | ✓ | ✗ (returns -32001) | ✓ |

The four `org.*` rows are new: those tools used to be dashboard-JWT-only on the
MCP surface, while the REST `/orgs` routes already served `lk_*` tokens. Both
surfaces now take tokens, through the same actor override
(`00041_org_actor_override.sql`).

**A token permission is not an org role, and does not become one.** The table
above says what the KEY may attempt. What the HOLDER may do is decided
separately by `lorekit_org_can` inside the SECURITY DEFINER RPCs, so a `lk_rw_*`
token owned by an org *viewer* passes the permission gate above and is then
refused the rename with `LK002`. Both gates apply, and neither substitutes for
the other.

**Scope restrictions do not currently narrow org operations.** A token with a
scope allowlist can still create, rename and soft-delete orgs — on MCP as on
REST, which has behaved this way since the org routes opened to tokens. Scope
restrictions were designed for lore, and orgs carry no scope to match against.
Whether an allowlist *ought* to imply "no org administration" is a real
question, deliberately left open rather than answered differently on each
surface; see [decisions.md](./decisions.md).

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
