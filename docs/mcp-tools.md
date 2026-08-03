# MCP Tools Reference

LoreKit exposes ten `memory.*` tools and four `org.*` tools via the MCP protocol.

`memory.*` tools require a valid API token (see [api-tokens.md](./api-tokens.md)).

`org.*` **MCP** tools require a **Supabase user JWT** (browser/dashboard session) — they are not available via `lk_*` API tokens, because these tool handlers call the org management RPCs without naming an actor, and those RPCs then derive it from `auth.uid()` inside `SECURITY DEFINER` functions (NULL on the service-role connection an API token gets).

**The REST `orgs` endpoints do accept `lk_*` tokens**, as of `supabase/migrations/00041_org_actor_override.sql` — the handlers there pass the token owner explicitly as `p_actor_user_id`, which the RPCs honour only on a verified service-role connection. Prefer `GET/POST/PATCH/DELETE /functions/v1/orgs` over these MCP tools when you are authenticating with an API token. Bringing the MCP `org.*` tools onto the same path is a follow-up.

**Endpoint:** `https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp`

---

## memory.write

Store or update a lesson. Requires a token with write permission (`lk_rw_*` or `lk_wo_*`).

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "id": 1,
  "params": {
    "name": "memory.write",
    "arguments": {
      "scope": "repo::mthines/gw-tools",
      "key": "aw-lessons::worktree-naming",
      "value": "Always use the branch name as the worktree directory name to avoid stash conflicts.",
      "tags": ["skill::aw", "source::stuck-loop"],
      "source_agent": "aw-executor",
      "trigger": "stuck-loop"
    }
  }
}
```

| Argument | Required | Description |
|----------|----------|-------------|
| `scope` | ✓ | Canonical scope string — see [scope-format.md](./scope-format.md) |
| `key` | ✓ | Lesson identifier (max 512 chars) |
| `value` | ✓ | Lesson body in markdown (max 64 KB) |
| `tags` | | Array of tag strings, e.g. `["skill::aw", "source::manual"]` |
| `source_agent` | | Name of the agent writing this lesson |
| `trigger` | | What triggered the write (`stuck-loop`, `pr-webhook`, `manual`) |
| `org` | | Org slug to write under (org-owned write). Omit for a personal memory. You must be a write-capable member (`member`/`admin`/`owner`, not `viewer`) of the org — verified server-side; supplying an org you're not authorized for is rejected. |
| `ttl_days` | | Integer 1–365. The memory auto-expires after this many days. Mutually exclusive with `ttl_minutes` and `ttl_seconds`; supply at most one. On an update, refreshes the expiry; omitting all three leaves the existing expiry unchanged. |
| `ttl_minutes` | | Integer 1–525600 (365 days in minutes). The memory auto-expires after this many minutes. Mutually exclusive with `ttl_days` and `ttl_seconds`. |
| `ttl_seconds` | | Integer 1–31536000 (365 days in seconds). The memory auto-expires after this many seconds. Useful for short-lived session memories (e.g. 30 s, 5 min). Mutually exclusive with `ttl_days` and `ttl_minutes`. |
| `origin_repo` | | Provenance: `owner/name` of the repository the lesson was recorded from. Lowercased. |
| `origin_branch` | | Provenance: the git branch the lesson was recorded from. Stored **verbatim** (case-sensitive) so the dashboard's `/tree/` link resolves. |
| `origin_commit` | | Provenance: the commit SHA (7–40 hex characters) checked out when the lesson was recorded. |
| `origin_pr` | | Provenance: the pull request number the lesson came out of. Rendered as a link to the PR when combined with `origin_repo`. |

**Provenance (`origin_*`).** `scope` says where a lesson **applies**; the four
`origin_*` fields say where it was **recorded from**, and the dashboard turns
them into links back to the pull request, branch, and commit. They matter most
for a `global` or `project::` lesson, whose scope names no repository at all.

Every field is independently optional and **the last KNOWN value wins**: on an
update, a field you omit keeps whatever a previous write recorded rather than
being erased, so a write from a machine with no git context is never
destructive. A malformed value is rejected (a 400 / tool error), never silently
dropped.

**They complement `scope`, they never contradict it.** Always send the full
origin, including `origin_repo`, even when the scope already names that repo —
storage stays complete so a lesson keeps its provenance if it is later re-scoped
or promoted from `branch::` to `repo::`. The *dashboard* is what de-duplicates:
the Metadata list shows one scope-derived **Repo** row (where the lesson
applies) and then only the origin rows that add something the scope cannot say.
A same-repo `origin_repo` is therefore not rendered twice, a `branch::` scope's
own branch is not repeated, and an origin in a *different* repo than the scope
is called out explicitly — that mismatch is a signal, not a bug.

The `lorekit` CLI fills these in automatically from git and the CI environment
(`LOREKIT_PR`, then `GITHUB_REF`'s `refs/pull/<n>/merge`, then
`GITHUB_PR_NUMBER`); pass `--no-origin` to opt out or `--origin-pr <n>` and
friends to override. Over the hosted MCP server the client has to supply them —
the server can only see what the call carries. The GitHub webhook receiver
records the PR, head branch, and head SHA of the delivery it ingested.

**Scope→org binding.** If you omit `org` but the scope is **bound to an org** (an admin set that up — see [org-sharing.md](./org-sharing.md#scope--org-binding-auto-routing)), the write auto-routes to that org **when you're a write-capable member**. If you're *not* a member, it's saved to your personal lore instead (never rejected) and the response carries a `notice` explaining that. An explicit `org` always overrides the binding.

**Returns:** `{ "id": "<uuid>", "created_at": "<iso>" }` — plus an optional `"expires_at": "<iso>"` when any `ttl_*` field was supplied, and an optional `"notice": "<string>"` when a write fell back to personal because the scope is bound to an org you can't write to.

**Default TTL — there isn't one, server-side.** Omitting every `ttl_*` field
means the memory never expires, and that is unchanged. Two things nonetheless
apply a default *before* the call reaches this endpoint, and neither is visible
here:

- The `lorekit` CLI resolves `ttl.default` / `scope.defaults.<prefix>.ttl_days`
  from the config layers and sends the result as `ttl_days` when `--ttl-days`
  and `--clear-ttl` were both absent. See
  [the CLI README](../packages/cli/README.md#default-ttl).
- The GitHub webhook receiver sets a TTL graded by the delivery's signal tier —
  90 days for a resolved review thread, 30 for a submitted review, 14 for a
  fresh comment (`packages/mcp-core/src/ttl-defaults.ts`).

An agent calling this tool directly gets neither: it cannot read a config file
on someone's laptop, so if a lesson should decay it has to say so with
`ttl_days`.

---

## memory.read

Read a single lesson by scope + key.

```json
{
  "params": {
    "name": "memory.read",
    "arguments": {
      "scope": "repo::mthines/gw-tools",
      "key": "aw-lessons::worktree-naming"
    }
  }
}
```

**Returns:** `{ "value": "<markdown>", "updated_at": "<iso>" }` or `null` if not found.

---

## memory.list

List all lessons for a scope, newest first.

```json
{
  "params": {
    "name": "memory.list",
    "arguments": {
      "scope": "global",
      "tags": ["skill::aw"],
      "limit": 20
    }
  }
}
```

| Argument | Default | Description |
|----------|---------|-------------|
| `scope` | required | Scope to list |
| `tags` | `[]` | Filter — only return lessons with at least one of these tags |
| `limit` | `50` | Max results (cap: 100) |

**Returns:** `{ "entries": [{ "key", "value", "tags", "updated_at" }] }`

---

## memory.delete

Soft-archive a lesson (default) or hard-delete it immediately. Requires a token with write permission (`lk_rw_*` or `lk_wo_*`).

```json
{
  "params": {
    "name": "memory.delete",
    "arguments": {
      "scope": "branch::mthines/gw-tools::feat/old-experiment",
      "key": "aw-lessons::stash-workaround",
      "force": false
    }
  }
}
```

| Argument | Default | Description |
|----------|---------|-------------|
| `scope` | required | Canonical scope string |
| `key` | required | Lesson identifier |
| `force` | `false` | When `true`, permanently hard-deletes the row (unrecoverable). When `false` (default), soft-archives the row — it is hidden from reads but can be listed via `memory.list_archived` and restored via `memory.restore`. |
| `org` | | Org slug to delete under (org-owned delete). Omit for a personal memory. Soft-archive requires a `member`/`admin`/`owner` role; hard-delete (`force: true`) requires `admin`/`owner` — a `viewer` or non-member is rejected on either. |

**Returns:** `{ "deleted": boolean, "archived": boolean }`

- Soft-archive (default): `{ "deleted": false, "archived": true }` if found, `{ "deleted": false, "archived": false }` if already archived or missing.
- Hard-delete (`force: true`): `{ "deleted": true, "archived": false }` if found, `{ "deleted": false, "archived": false }` if not found.

---

## memory.search

Full-text search across all lessons. Supports owner-level scope wildcards.

```json
{
  "params": {
    "name": "memory.search",
    "arguments": {
      "q": "worktree naming conflict",
      "scopes": ["repo::mthines/*", "global"],
      "tags": ["skill::aw"],
      "limit": 10
    }
  }
}
```

| Argument | Default | Description |
|----------|---------|-------------|
| `q` | required | Full-text query (Postgres `websearch` mode) |
| `scopes` | all scopes | Scope filters. Supports `repo::owner/*` wildcard |
| `tags` | `[]` | AND-filter on tags |
| `limit` | `20` | Max results (cap: 100) |

**Returns:** `{ "entries": [{ "key", "value", "scope", "tags", "rank" }] }`

---

## memory.archive

Soft-archive a lesson. Archived entries are hidden from normal reads (`memory.read`, `memory.list`) but
can be listed via `memory.list_archived` and fully restored via `memory.restore`. Requires a token with write permission (`lk_rw_*` or `lk_wo_*`).

```json
{
  "params": {
    "name": "memory.archive",
    "arguments": {
      "scope": "global",
      "key": "aw-lessons::old-tip"
    }
  }
}
```

**Returns:** `{ "archived": true }` if the row was found and archived, `{ "archived": false }` if it was already archived or not found.

---

## memory.restore

Restore a soft-archived lesson back to active. Requires a token with write permission (`lk_rw_*` or `lk_wo_*`).

```json
{
  "params": {
    "name": "memory.restore",
    "arguments": {
      "scope": "global",
      "key": "aw-lessons::old-tip"
    }
  }
}
```

**Returns:** `{ "restored": true }` if the row was found in the archive and cleared, `{ "restored": false }` if it was already active or not found.

---

## memory.list_archived

List soft-archived lessons for a scope, newest archived first. Requires a token with read permission (`lk_rw_*` or `lk_ro_*`).

```json
{
  "params": {
    "name": "memory.list_archived",
    "arguments": {
      "scope": "global",
      "limit": 20
    }
  }
}
```

| Argument | Default | Description |
|----------|---------|-------------|
| `scope` | required | Scope to list archived entries for |
| `limit` | `50` | Max results (cap: 100) |

**Returns:** `{ "entries": [{ "key", "value", "tags", "updated_at", "archived_at" }] }`

---

## memory.purge

Permanently delete archived lessons whose `archived_at` timestamp is older than `retention_days`.
This operation is unrecoverable. Requires a token with write permission (`lk_rw_*` or `lk_wo_*`).

> **Note:** Service-role callers (CI) cannot call this tool — the purge is always scoped to a specific user.
> Use the Supabase RPC `purge_archived_memories` directly for admin purges.

```json
{
  "params": {
    "name": "memory.purge",
    "arguments": {
      "retention_days": 30
    }
  }
}
```

| Argument | Default | Description |
|----------|---------|-------------|
| `retention_days` | `30` | Minimum age (in days) since archiving before a row becomes eligible. Min: 1, Max: 365. |

**Returns:** `{ "purged": number }` — count of permanently deleted rows.

---

## memory.purge_expired

Permanently hard-delete all TTL-expired memories for the current user. Expired rows
are those with an `expires_at` in the past that have not yet been physically removed.
Requires a token with write permission (`lk_rw_*` or `lk_wo_*`).

This tool complements `memory.purge` (which removes archived rows) and is safe to
call periodically — it only removes rows the caller wrote and whose TTL has elapsed.

```json
{
  params: {
    name: memory.purge_expired,
    arguments: {}
  }
}
```

No arguments required.

**Returns:** `{ purged: <count> }` — number of expired rows permanently deleted.

---

## Error codes

| JSON-RPC code | Meaning |
|---------------|---------|
| `-32001` | Unauthorized — missing, invalid, or expired token |
| `-32001` | Read-only token attempted a write operation, or a write-only token attempted a read operation |
| `-32603` | Tool execution error (DB error, scope validation failure) |
| `-32700` | Parse error — malformed JSON body |
| `-32601` | Unknown method or tool name |

---

## Connecting your agent

The fastest path is `npx @lorekit/cli install` — it scaffolds the `lorekit-memory` and `lorekit-setup` skills, wires the MCP server, and installs the lifecycle hooks in one command. See the [CLI README](../packages/cli/README.md) for flags.

For a manual `.mcp.json` entry (any MCP-compatible agent):

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

Generate a token from the LoreKit dashboard: **Overview → Connect your agent → Generate new token**.

---

## org.create

Create a new organization. You become its `owner` automatically. The slug must be globally unique and lowercase.

**Auth:** Supabase user JWT required. Not available via API token.

```json
{
  "params": {
    "name": "org.create",
    "arguments": {
      "slug": "my-team",
      "name": "My Team"
    }
  }
}
```

| Argument | Required | Description |
|----------|----------|-------------|
| `slug` | ✓ | Lowercase unique identifier for the org (letters, digits, hyphens) |
| `name` | ✓ | Human-readable display name |

**Returns:** `{ "id": "<uuid>", "slug": "<slug>", "name": "<name>" }`

---

## org.list

List all organizations you are a member of, with your role in each.

**Auth:** Supabase user JWT required. Not available via API token.

```json
{
  "params": {
    "name": "org.list",
    "arguments": {}
  }
}
```

**Returns:** `{ "entries": [{ "id", "slug", "name", "role", "created_at" }] }`

Roles: `owner`, `admin`, `member`, `viewer`.

---

## org.rename

Rename an organization's display name. Requires `admin` or `owner` role.

**Auth:** Supabase user JWT required. Not available via API token.

```json
{
  "params": {
    "name": "org.rename",
    "arguments": {
      "slug": "my-team",
      "name": "My Team (renamed)"
    }
  }
}
```

| Argument | Required | Description |
|----------|----------|-------------|
| `slug` | ✓ | The org slug to update |
| `name` | ✓ | New display name |

**Returns:** `{ "slug": "<slug>", "name": "<new-name>" }`

---

## org.delete

Soft-delete an organization. Requires `owner` role. All org-owned lore is immediately hidden from all reads. The deletion is permanent from a user's perspective — no restore via MCP.

**Auth:** Supabase user JWT required. Not available via API token.

```json
{
  "params": {
    "name": "org.delete",
    "arguments": {
      "slug": "my-old-team"
    }
  }
}
```

| Argument | Required | Description |
|----------|----------|-------------|
| `slug` | ✓ | The org slug to delete |

**Returns:** `{ "deleted": true, "slug": "<slug>" }`
