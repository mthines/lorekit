# MCP Tools Reference

LoreKit exposes five tools via the MCP protocol. All tools require a valid API token (see [api-tokens.md](./api-tokens.md)).

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

Delete a single lesson. Requires a **read+write** token.

```json
{
  "params": {
    "name": "memory.delete",
    "arguments": {
      "scope": "branch::mthines/gw-tools::feat/old-experiment",
      "key": "aw-lessons::stash-workaround"
    }
  }
}
```

**Returns:** `{ "deleted": true }` or `{ "deleted": false }` if not found.

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
