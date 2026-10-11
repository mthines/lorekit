# Judgment reranking (TypeSafe / Jev)

`GET /memories/relevant` optionally reranks its shortlist using TypeSafe's
Jev judgment model — **bring your own key (BYOK)**. There is no LoreKit-operated
TypeSafe account and no shared quota: a user configures their own key, and
every judgment call spends that account, not LoreKit's.

See [decisions.md](./decisions.md#judgment-is-byok-best-effort-never-on-the-correctness-path)
for why this is BYOK and best-effort by design, and [otel.md](./otel.md#judgment-reranking-byok)
for the span/attribute contract.

## Configuring a key

`POST /memories/judgment-key` with a Supabase JWT (not an `lk_*` API token —
this is a personal secret, never delegated to a token):

```bash
curl -X POST https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/memories/judgment-key \
  -H "Authorization: Bearer $SUPABASE_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"api_key": "sk-typesafe-..."}'
# → { "configured": true, "last4": "a1b2" }
```

Calling it again **rotates** the key — the old value is discarded and replaced
in the same Vault row.

## Checking status

`GET /memories/judgment-key`:

```json
{
  "configured": true,
  "provider": "typesafe",
  "last4": "a1b2",
  "status": "active",
  "calls_total": 42,
  "created_at": "2026-09-01T12:00:00.000Z"
}
```

`status` is `"active"` or `"rejected"` — TypeSafe answered 401/403 on the most
recent call and hasn't since answered anything else. It self-heals to
`"active"` the next time a call to that exact key version succeeds (or
fails for any OTHER reason), so a temporarily-rejected key is never
permanently stuck once the underlying problem is fixed. `configured: false`
when nothing is set — every other field is `null` in that case.

## Removing a key

`DELETE /memories/judgment-key`. Idempotent: `{ "deleted": false }` when
nothing was configured, `{ "deleted": true }` otherwise. The underlying Vault
secret is removed as part of the same operation (and also on account
deletion — see the migration).

## What actually happens on a judged read

`GET /memories/relevant?q=...` — when the caller has an `active` key and `q`
is set — sends the shortlisted candidates (capped at 25, org-owned rows
excluded) to TypeSafe in ONE batched request, with a 1.5s timeout and no
retries. TypeSafe's Score answers replace each candidate's `relevance` factor;
everything else about the ranking (recency, salience, outcome, MMR
diversification) is unchanged. See
[`packages/mcp-core/src/judgment/judgment.ts`](../packages/mcp-core/src/judgment/judgment.ts)
for the exact wire format and scoring math.

**Every outcome other than a successful, well-formed response reproduces the
byte-identical pre-judgment baseline** — no key, a disabled instance, no `q`,
no eligible candidates, a timeout, a rejected/rate-limited key, or a malformed
response are all handled identically: the read falls back to the ranking it
would have produced before this feature existed. Judgment can only ever make
a `/relevant` read as good as it was, or better — never worse and never
slower by more than the 1.5s cap.

## Storage

The key is Vault-encrypted (`supabase/migrations/00112_judgment_provider_keys.sql`)
and metadata-only in `judgment_provider_keys` (owner, provider, `last4`,
`status`, a rotation `version`, `calls_total`). The table has no RLS policy —
access is entirely through five `security definer` functions granted to
`service_role` only, called exclusively by
[`supabase/functions/_shared/judgment/judgment-keys.ts`](../supabase/functions/_shared/judgment/judgment-keys.ts).
The decrypted value is read back in exactly one place
([`judgment-client.ts`](../supabase/functions/_shared/judgment/judgment-client.ts))
for the one outbound call that needs it, and is never logged, spanned, or
audited.

## Environment

| Variable | Effect |
|----------|--------|
| `LOREKIT_JUDGMENT_DISABLED` | Operator kill switch. `true`/`1`/`yes`/`on` short-circuits every judgment attempt to `skipped_disabled`, checked before any per-user key lookup. |

## Known gaps (tracked, not yet shipped)

- No web Settings UI yet — the REST endpoints above are the only way to
  configure a key today.
- No CLI-side judgment (the failure-hook rerank) yet — the CLI's pure
  `judgment-pure.mjs` twin exists, but the fetch shell
  (`packages/cli/src/core/judgment.mjs`) and `doctor`/hook wiring do not.
- No DB-level regression test section (`migrations.test.sql`) for the
  set/get/status/delete/record_call RPCs yet — CI's `Integration smoke`
  job, which applies every migration against a real Supabase stack with real
  Vault, is the arbiter until one is authored.
