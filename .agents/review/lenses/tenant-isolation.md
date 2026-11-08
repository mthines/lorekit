---
for: pr-reviewer
lens-version: 1
applies-to: "supabase/functions/**, packages/mcp-core/src/**"
diff-matches: '\.from\(|\.rpc\(|entitled|verdict|createClient'
---

# Tenant isolation — Review Lens

## Trigger

An added line in an Edge Function or `mcp-core` that queries the database, calls an RPC, or computes an entitlement. `lk_*` API-token auth runs as the service-role client, so RLS does not protect it: the code is the only guard.

## Checklist

- [ ] Every query or RPC reachable with an `lk_*` token filters on the caller (`.eq('user_id', userId)`, `applyTenantScope`, or an RPC argument the function checks); a service-role call with no tenant predicate is a cross-tenant read.
- [ ] Tenant visibility goes through `applyTenantScope` (RLS side: `lorekit_member_org_ids()`), never a hand-rolled org or user predicate.
- [ ] Where a handler takes a caller-supplied resource id, the same `entitled` / `verdict.kind === 'linked'` value that gates the write also gates every field of the success body; no field sourced from the fetched third-party object is returned to an unentitled caller.
- [ ] A new tool or route is listed in `READ_TOOLS` or `WRITE_TOOLS` BY HAND, not derived from the catalog, and the permission matches what the handler does (`lk_ro_*` never reaches a write, `lk_wo_*` never a read).
- [ ] A denial keeps its documented shape: a tool-originated failure (including `LK002` org capability) is an in-band `isError` result, a token or key-scope denial is a protocol-level `-32003`, and a missing or invalid token is `-32001`; the defect is a denial returned as a success payload with neither `isError` nor a JSON-RPC `error` (`docs/decisions.md`, "A tool-originated MCP failure is an `isError` result").

## Severity hints

- **Must-fix**: a tenant-free service-role query, a response field leaked past `entitled`, a tool missing from the hand-written permission lists.
- **Should-fix**: a hand-rolled visibility predicate, a wrong denial code.
