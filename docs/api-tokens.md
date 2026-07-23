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

The prefix encodes the permission so it's visible in config files at a glance.

Tokens are stored as **SHA-256 hashes** in the database. The full token is shown once on creation and cannot be retrieved again — treat it like a password.

## Generating a token

1. Go to the LoreKit dashboard → **Overview**
2. Expand **Step 2: Connect your agent**
3. Click **Generate new token**
4. Enter a name (e.g. `aw-executor`, `ci-github-actions`, `local-dev`)
5. Choose **Read + Write** or **Read only**
6. Copy the token from the amber banner — it won't be shown again

## Permission matrix

| Tool | Read + Write (`lk_rw_`) | Read only (`lk_ro_`) |
|------|------------------------|---------------------|
| `memory.write` | ✓ | ✗ (returns -32001) |
| `memory.read` | ✓ | ✓ |
| `memory.list` | ✓ | ✓ |
| `memory.delete` | ✓ | ✗ (returns -32001) |
| `memory.search` | ✓ | ✓ |

## Using a token

Pass the token as a Bearer header:

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer lk_rw_<your-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory.list","arguments":{"scope":"global"}}}'
```

In `persistent-memory` config:

```json
{
  "backend": "mcp",
  "mcp": {
    "server": "https://<project-ref>.supabase.co/functions/v1/mcp",
    "auth": { "type": "bearer", "token": "lk_rw_<your-token>" }
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
    LOREKIT_MCP_URL: https://<project-ref>.supabase.co/functions/v1/mcp
    LOREKIT_TOKEN: ${{ secrets.LOREKIT_TOKEN }}
```

## Revoking a token

In the dashboard → Overview → Step 2 → your token list → click the trash icon → confirm. Revocation is immediate.

## Limits

- Maximum 20 tokens per user account.
- No expiry — tokens are valid until revoked.
- `last_used_at` is updated on every successful authentication.
