# MCP Tools Reference

LoreKit exposes nine tools via the MCP protocol. All tools require a valid API token (see [api-tokens.md](./api-tokens.md)).

**Endpoint:** `https://<project-ref>.supabase.co/functions/v1/mcp`

---

## memory.write

Store or update a lesson. Requires a **read+write** token (`lk_rw_*`).

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

**Returns:** `{ "id": "<uuid>", "created_at": "<iso>" }`

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

Soft-archive a lesson (default) or hard-delete it immediately. Requires a **read+write** token.

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
can be listed via `memory.list_archived` and fully restored via `memory.restore`. Requires a **read+write** token.

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

Restore a soft-archived lesson back to active. Requires a **read+write** token.

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

List soft-archived lessons for a scope, newest archived first. Requires a **read+write** or **read-only** token.

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
This operation is unrecoverable. Requires a **read+write** token.

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
| `-32001` | Read-only token attempted a write operation |
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
    "server": "https://<project-ref>.supabase.co/functions/v1/mcp",
    "auth": {
      "type": "bearer",
      "token": "lk_rw_<your-token>"
    }
  }
}
```

Generate a token from the LoreKit dashboard: **Overview → Step 2 → Generate new token**.
