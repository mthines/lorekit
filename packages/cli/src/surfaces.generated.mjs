// GENERATED — do not edit.
// Source: packages/schemas/src/tool-catalog.ts
// Regenerate: node scripts/gen-surfaces.mjs
//
// Edit the catalog's `surfaces` bindings, not this file. `--check` fails CI
// when the two disagree.

/** Every catalog op, in `tools/list` wire order. */
export const MCP_TOOL_NAMES = [
  "memory.write",
  "memory.read",
  "memory.list",
  "memory.delete",
  "memory.search",
  "memory.archive",
  "memory.scopes",
  "memory.list_archived",
  "memory.restore",
  "memory.purge",
  "memory.purge_expired",
  "org.create",
  "org.list",
  "org.rename",
  "org.delete"
];

/** The `memory.*` family — dispatched against a store (local or remote). */
export const MEMORY_TOOL_NAMES = [
  "memory.write",
  "memory.read",
  "memory.list",
  "memory.delete",
  "memory.search",
  "memory.archive",
  "memory.scopes",
  "memory.list_archived",
  "memory.restore",
  "memory.purge",
  "memory.purge_expired"
];

/** The `org.*` family — always proxied to the REST API, never the local store. */
export const ORG_TOOL_NAMES = [
  "org.create",
  "org.list",
  "org.rename",
  "org.delete"
];

/**
 * The `tools/list` payload: name, description and inputSchema per op.
 * Identical projection to the edge server's, from the same declaration, so the
 * local stdio server and the hosted server advertise the same contract.
 */
export const MCP_TOOL_DEFS = [
  {
    "name": "memory.write",
    "description": "Store or update a lesson",
    "inputSchema": {
      "type": "object",
      "required": [
        "scope",
        "key",
        "value"
      ],
      "properties": {
        "scope": {
          "type": "string",
          "description": "Canonical scope string, e.g. `repo::mthines/lorekit`."
        },
        "key": {
          "type": "string",
          "description": "Lesson identifier, unique within the scope. Max 512 characters."
        },
        "value": {
          "type": "string",
          "description": "Lesson body in markdown. Max 64 KB."
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Free-form labels, e.g. `[\"skill::aw\", \"source::stuck-loop\"]`."
        },
        "source_agent": {
          "type": "string",
          "description": "Name of the agent writing this lesson."
        },
        "trigger": {
          "type": "string",
          "description": "What triggered the write: `stuck-loop`, `pr-webhook`, `manual`."
        },
        "kind": {
          "type": "string",
          "enum": [
            "lesson",
            "bus",
            "signal"
          ],
          "description": "The bucket kind: `lesson` (procedural, read every run), `bus` (transient outcome event, read at promotion time), or `signal` (durable per-repo filter, read every run). Omit to have it inferred from a `loop::<host>-lessons` tag."
        },
        "host": {
          "type": "string",
          "description": "The owning skill or agent (e.g. `reviewer`, `aw`, `ci-auto-fix`). Omit to have it inferred from a `loop::<host>-lessons` tag."
        },
        "created_at": {
          "type": "string",
          "format": "date-time",
          "description": "Optional ISO 8601 creation date. Use when migrating a pre-existing memory so it is dated by its original time instead of now. Rejected if invalid or in the future. Applies only when the memory is first created."
        },
        "org": {
          "type": "string",
          "description": "Org slug to write under (org-owned write). Omit for a personal memory. You must be a write-capable member (member/admin/owner, not viewer) of the org, verified server-side — supplying an org slug you are not authorized for is rejected."
        },
        "ttl_days": {
          "type": "integer",
          "minimum": 1,
          "maximum": 365,
          "description": "Number of days until the memory auto-expires. Omit for a permanent memory. On an update, supplying ttl_days refreshes the expiry; omitting it leaves the existing expiry unchanged."
        },
        "clear_ttl": {
          "type": "boolean",
          "description": "When true, removes the existing expiry and makes the memory permanent again. Takes precedence over ttl_days when both are supplied."
        },
        "origin_repo": {
          "type": "string",
          "description": "Provenance: the owner/name of the repository this memory was recorded from. Distinct from `scope`, which says where the lesson APPLIES."
        },
        "origin_branch": {
          "type": "string",
          "description": "Provenance: the git branch this memory was recorded from. Stored verbatim (case-sensitive) so its GitHub link resolves."
        },
        "origin_commit": {
          "type": "string",
          "description": "Provenance: the commit SHA (7-40 hex characters) checked out when this memory was recorded."
        },
        "origin_pr": {
          "type": "integer",
          "minimum": 1,
          "description": "Provenance: the pull request number this memory was recorded from. Combined with origin_repo it renders as a link to the PR."
        }
      }
    }
  },
  {
    "name": "memory.read",
    "description": "Read a lesson by scope and key",
    "inputSchema": {
      "type": "object",
      "required": [
        "scope",
        "key"
      ],
      "properties": {
        "scope": {
          "type": "string",
          "description": "Canonical scope string, e.g. `repo::mthines/lorekit`."
        },
        "key": {
          "type": "string",
          "description": "Lesson identifier, unique within the scope. Max 512 characters."
        }
      }
    }
  },
  {
    "name": "memory.list",
    "description": "List lessons for a scope",
    "inputSchema": {
      "type": "object",
      "required": [
        "scope"
      ],
      "properties": {
        "scope": {
          "type": "string",
          "description": "Canonical scope string, e.g. `repo::mthines/lorekit`."
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Filter to entries carrying ANY of these labels (OR)."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 50,
          "description": "Maximum entries to return."
        },
        "cursor": {
          "type": "string",
          "description": "Opaque cursor from a previous response's `nextCursor`. Omit to start from the first page. Ignored when `order` is `rank` (ranked mode returns a single bounded page; `hasMore` is always false and `nextCursor` always null)."
        },
        "order": {
          "type": "string",
          "enum": [
            "recency",
            "rank"
          ],
          "default": "recency",
          "description": "recency (default, updated_at desc + cursor pagination) or rank (salience+recency; bounded top-N, no cursor). Note: rank results are MMR-diversified, so they are NOT strictly score-descending — a more diverse lower-scored lesson can precede a higher-scored near-duplicate."
        },
        "kind": {
          "type": "string",
          "enum": [
            "lesson",
            "bus",
            "signal"
          ],
          "description": "Filter to one bucket family: `lesson` (procedural, read every run), `bus` (transient outcome event), or `signal` (durable per-repo filter). Rows written before the taxonomy existed have no kind and are excluded when this is set."
        },
        "host": {
          "type": "string",
          "description": "Filter to the owning skill or agent, e.g. `reviewer`, `aw`, `ci-auto-fix`. Combine with `kind` to read exactly one bucket (\"lessons for host reviewer\")."
        },
        "view": {
          "type": "string",
          "enum": [
            "full",
            "summary"
          ],
          "default": "full",
          "description": "full (default) returns each entry's complete `value`. summary omits `value` and returns `value_bytes` + a 200-character `preview` instead — the cheap discovery read for deciding WHICH lessons to then fetch with `memory.read`."
        }
      }
    }
  },
  {
    "name": "memory.delete",
    "description": "Soft-archive a lesson (default) or hard-delete it (force: true). Archived lessons are hidden from reads but can be restored.",
    "inputSchema": {
      "type": "object",
      "required": [
        "scope",
        "key"
      ],
      "properties": {
        "scope": {
          "type": "string",
          "description": "Canonical scope string, e.g. `repo::mthines/lorekit`."
        },
        "key": {
          "type": "string",
          "description": "Lesson identifier, unique within the scope. Max 512 characters."
        },
        "force": {
          "type": "boolean",
          "default": false,
          "description": "Hard-delete immediately (unrecoverable). Defaults to false (soft-archive)."
        },
        "org": {
          "type": "string",
          "description": "Org slug to delete under (org-owned delete). Omit for a personal memory. Soft-archive requires a member/admin/owner role; hard-delete (force: true) requires admin/owner — verified server-side."
        }
      }
    }
  },
  {
    "name": "memory.search",
    "description": "Full-text search across lessons",
    "inputSchema": {
      "type": "object",
      "required": [
        "q"
      ],
      "properties": {
        "q": {
          "type": "string",
          "description": "Full-text query."
        },
        "scopes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Scopes to search. Accepts an owner-level wildcard, e.g. `repo::mthines/*` — the only tool that does."
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Filter to entries carrying ALL of these labels (AND)."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 20,
          "description": "Maximum entries to return."
        },
        "cursor": {
          "type": "string",
          "description": "Opaque cursor from a previous response's `nextCursor`. Omit to start from the first page."
        }
      }
    }
  },
  {
    "name": "memory.archive",
    "description": "Soft-archive a lesson. Archived lessons are hidden from reads but can be restored via memory.restore.",
    "inputSchema": {
      "type": "object",
      "required": [
        "scope",
        "key"
      ],
      "properties": {
        "scope": {
          "type": "string",
          "description": "Canonical scope string, e.g. `repo::mthines/lorekit`."
        },
        "key": {
          "type": "string",
          "description": "Lesson identifier, unique within the scope. Max 512 characters."
        }
      }
    }
  },
  {
    "name": "memory.scopes",
    "description": "List every scope in the store with how many active memories it holds and when it was last written to — the inventory to consult when you do not already know which scope to read. Takes no arguments and is store-wide, NOT limited to any working directory. Every other read tool requires a scope up front, so this is the one that answers \"what is there?\".",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "memory.list_archived",
    "description": "List archived (soft-deleted) lessons for a scope",
    "inputSchema": {
      "type": "object",
      "required": [
        "scope"
      ],
      "properties": {
        "scope": {
          "type": "string",
          "description": "Canonical scope string, e.g. `repo::mthines/lorekit`."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 50,
          "description": "Maximum entries to return."
        }
      }
    }
  },
  {
    "name": "memory.restore",
    "description": "Restore an archived lesson back to active",
    "inputSchema": {
      "type": "object",
      "required": [
        "scope",
        "key"
      ],
      "properties": {
        "scope": {
          "type": "string",
          "description": "Canonical scope string, e.g. `repo::mthines/lorekit`."
        },
        "key": {
          "type": "string",
          "description": "Lesson identifier, unique within the scope. Max 512 characters."
        }
      }
    }
  },
  {
    "name": "memory.purge",
    "description": "Permanently delete archived lessons older than retention_days (default 30). Unrecoverable.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "retention_days": {
          "type": "integer",
          "minimum": 1,
          "maximum": 365,
          "default": 30,
          "description": "Only purge archived lessons older than this many days."
        }
      }
    }
  },
  {
    "name": "memory.purge_expired",
    "description": "Permanently delete all TTL-expired memories for the current user. Unrecoverable.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "org.create",
    "description": "Create a new organization. You become its owner automatically. The slug must be globally unique and lowercase.",
    "inputSchema": {
      "type": "object",
      "required": [
        "slug",
        "name"
      ],
      "properties": {
        "slug": {
          "type": "string",
          "description": "Unique lowercase org identifier, e.g. \"my-team\""
        },
        "name": {
          "type": "string",
          "description": "Human-readable display name"
        }
      }
    }
  },
  {
    "name": "org.list",
    "description": "List all organizations you are a member of, with your role in each.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "org.rename",
    "description": "Rename an organization's display name. Requires admin or owner role.",
    "inputSchema": {
      "type": "object",
      "required": [
        "slug",
        "name"
      ],
      "properties": {
        "slug": {
          "type": "string",
          "description": "The org slug to update"
        },
        "name": {
          "type": "string",
          "description": "New display name"
        }
      }
    }
  },
  {
    "name": "org.delete",
    "description": "Delete an organization. Requires owner role. Soft-deletes the org — all org lore is immediately hidden from reads. Unrecoverable via MCP.",
    "inputSchema": {
      "type": "object",
      "required": [
        "slug"
      ],
      "properties": {
        "slug": {
          "type": "string",
          "description": "The org slug to delete"
        }
      }
    }
  }
];

/** CLI command name -> the catalog op it invokes. */
export const CLI_BINDINGS = {
  "write": "memory.write",
  "show": "memory.read",
  "list": "memory.list",
  "delete": "memory.delete",
  "search": "memory.search",
  "archive": "memory.archive",
  "scopes": "memory.scopes",
  "restore": "memory.restore",
  "purge": "memory.purge",
  "purge-expired": "memory.purge_expired"
};

/** CLI alias -> canonical command name. */
export const CLI_ALIASES = {
  "ls": "list",
  "rm": "delete",
  "grep": "search"
};

/**
 * Op -> why it has NO CLI command. A declared exemption, so absence from the
 * CLI is a reviewable decision rather than an oversight.
 */
export const CLI_EXEMPT = {
  "memory.list_archived": "surfaced as a flag on an existing command — `lorekit list --archived` — not a command of its own",
  "org.create": "org management reaches the CLI via the local stdio MCP server (`lorekit mcp`), not a `lorekit` subcommand",
  "org.list": "org management reaches the CLI via the local stdio MCP server (`lorekit mcp`), not a `lorekit` subcommand",
  "org.rename": "org management reaches the CLI via the local stdio MCP server (`lorekit mcp`), not a `lorekit` subcommand",
  "org.delete": "org management reaches the CLI via the local stdio MCP server (`lorekit mcp`), not a `lorekit` subcommand"
};

/** Op -> why the local stdio MCP server does not dispatch it. */
export const LOCAL_MCP_EXEMPT = {
  "memory.list_archived": "reachable through memory.list's archived filter on the offline store",
  "memory.purge": "account-wide sweep against server-side state; the offline store has no equivalent",
  "memory.purge_expired": "account-wide sweep against server-side state; the offline store has no equivalent"
};

/**
 * Default retention window for `memory.purge`, in days.
 *
 * Derived rather than restated: this value appears in the tool description the
 * server advertises, in the CLI's help text, and in the CLI's client-side
 * validation. Three hand-written copies of one number is three chances for the
 * help to promise a default the server does not apply.
 */
export const PURGE_RETENTION_DAYS_DEFAULT = 30;
