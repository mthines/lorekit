# API Tokens

LoreKit has **two** ways to authenticate an agent:

| | Where it comes from | Expires | Org access | Best for |
|---|---|---|---|---|
| **OAuth ("Authorize")** | Your MCP client's Authorize button | 30 days | Only the orgs you tick on the consent screen | Attaching an editor / agent on a machine you use interactively |
| **Personal token** | Dashboard → Settings → API keys | Never (until revoked) | Every org you belong to | CI, scripts, headless jobs |

Both produce the same `lk_*` credential and are listed and revoked in the same place. Start with OAuth unless you need a token that never expires. The OAuth flow is described in [Authorizing an MCP client](#authorizing-an-mcp-client-oauth) below; the rest of this page covers personal tokens.

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
- No expiry — tokens are valid until revoked.
- `last_used_at` is updated on every successful authentication.

## Authorizing an MCP client (OAuth)

Modern MCP hosts (Claude Code, Cursor, ChatGPT, VS Code) show an **Authorize**
action next to a server that requires authentication. LoreKit implements the
OAuth 2.1 authorization-code flow with PKCE that those buttons drive, so you can
connect a client without generating or pasting a token.

### Using it

1. Add the LoreKit MCP server to your client **without** a token:

   ```jsonc
   {
     "mcpServers": {
       "lorekit": {
         "url": "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp"
       }
     }
   }
   ```

2. Press **Authorize**. Your browser opens `https://lorekit.io/oauth/authorize`.
3. Sign in if you are not already.
4. On the consent screen choose:
   - **Access level** — read + write, or read only.
   - **Which lore** — your personal lore is always included; each organization
     you belong to is a separate, opt-in checkbox.
5. Press **Authorize**. The browser hands the client a token and you are done.

The issued token appears in **Settings → API keys** alongside your personal
tokens, named after the client that requested it, and can be revoked there.

### What the consent choices mean

- **Organizations are narrowing, never widening.** Ticking an org lets the
  connection reach it; leaving one unticked hides it. Leaving the organization
  itself revokes access immediately, whatever the token says — membership is
  always re-checked per request.
- **The token expires after 30 days.** Re-authorizing is the same one-click
  flow, and it replaces the previous token rather than accumulating dead ones.
- **Re-authorizing with different orgs replaces the grant.** There is one live
  OAuth token per client per user.

### How discovery works

| Step | Endpoint |
|---|---|
| Client calls the MCP server with no credential | `401` + `WWW-Authenticate: Bearer resource_metadata="…"` |
| Client fetches the resource metadata (RFC 9728) | `GET …/functions/v1/mcp/.well-known/oauth-protected-resource` |
| Client fetches the authorization-server metadata (RFC 8414) | `GET https://lorekit.io/.well-known/oauth-authorization-server` |
| Client registers itself (RFC 7591) | `POST https://lorekit.io/api/oauth/register` |
| User consents | `GET https://lorekit.io/oauth/authorize` |
| Client exchanges code + PKCE verifier | `POST https://lorekit.io/api/oauth/token` |
| Client hands the token back on disconnect | `POST https://lorekit.io/api/oauth/revoke` |

The MCP server on `*.supabase.co` is the **resource** server; the dashboard on
`lorekit.io` is the **authorization** server. Only a request that presents *no*
credential gets a `401` — a request carrying an invalid or expired token still
gets an in-band JSON-RPC error, because a `401` there makes streamable-HTTP
clients retry silently and hang.

PKCE is mandatory and only `S256` is accepted. There is no client secret:
LoreKit registers public clients only.
