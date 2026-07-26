# MCP Tools Reference

LoreKit exposes nine `memory.*` tools and four `org.*` tools via the MCP protocol.

`memory.*` tools require a valid API token (see [api-tokens.md](./api-tokens.md)).

`org.*` tools require a **Supabase user JWT** (browser/dashboard session) — they are not available via `lk_*` API tokens because org management RPCs derive the actor from `auth.uid()` inside `SECURITY DEFINER` functions.

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

**Scope→org binding.** If you omit `org` but the scope is **bound to an org** (an admin set that up — see [org-sharing.md](./org-sharing.md#scope--org-binding-auto-routing)), the write auto-routes to that org **when you're a write-capable member**. If you're *not* a member, it's saved to your personal lore instead (never rejected) and the response carries a `notice` explaining that. An explicit `org` always overrides the binding.

**Returns:** `{ "id": "<uuid>", "created_at": "<iso>" }` — plus an optional `"notice": "<string>"` when a write fell back to personal because the scope is bound to an org you can't write to.

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

## Error codes

| JSON-RPC code | Meaning |
|---------------|---------|
| `-32001` | Unauthorized — missing, invalid, or expired token |
| `-32001` | Read-only token attempted a write operation, or a write-only token attempted a read operation |
| `-32603` | Tool execution error (DB error, scope validation failure) |
| `-32700` | Parse error — malformed JSON body |
| `-32601` | Unknown method or tool name |

---

## Using with `persistent-memory` skill

In your project's `.claude/skills/persistent-memory/config.json`:

```json
{
  "backend": "mcp",
  "mcp": {
    "server": "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp",
    "auth": {
      "type": "bearer",
      "token": "lk_rw_<your-token>"
    }
  }
}
```

Generate a token from the LoreKit dashboard: **Overview → Step 2 → Generate new token**.

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
