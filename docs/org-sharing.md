# Organizations & shared lore

By default every memory is **personal** — visible only to the user (or token)
that wrote it. **Organizations** let a team share one authoritative set of
lessons: an org owns the rows, and every member reads and writes the same
shared lore.

This is **org-first**, not copy-on-share. There is a single shared row owned by
the org — not a personal copy fanned out to each member — so an update is seen
by everyone immediately and nothing drifts out of sync.

> **Audience:** dashboard users setting up sharing, and operators enabling
> invite emails. For the agent-facing tool parameters (`org` on `memory.write` /
> `memory.delete`), see [mcp-tools.md](./mcp-tools.md). For the data model and
> the tenant-visibility invariant, see [architecture.md](./architecture.md#organizations).

---

## Roles & capabilities

Every membership has one role. Capabilities are cumulative and enforced
server-side (a single SQL source of truth, `lorekit_org_can`) — the dashboard UI
only ever mirrors them.

| Role | Read shared lore | Write / archive / restore | Hard-delete lore | Manage members & invites | Rename / delete org |
|------|:---:|:---:|:---:|:---:|:---:|
| **viewer** | ✅ | — | — | — | — |
| **member** | ✅ | ✅ | — | — | — |
| **admin** | ✅ | ✅ | ✅ | ✅ | — |
| **owner** | ✅ | ✅ | ✅ | ✅ | ✅ |

Two invariants hold regardless of role:

- An admin may act only on `member`/`viewer` targets — never on an `owner` or
  another `admin`.
- The **last remaining owner** can never be removed, demoted, or leave.
  Ownership is **non-transferable** in v1 (invites can't grant `owner`).

---

## Set up sharing (dashboard)

Everything lives at **Settings → Organization**.

1. **Create an organization.** Give it a name (`Acme Team`) and a URL-safe slug
   (`acme-team`). You become its **owner**.
2. **Invite teammates.** Enter a GitHub handle *or* an email address and pick a
   role. Owner/admin only.
   - An **email** invite also sends a notification email (if email is
     configured — see [below](#invite-emails)).
   - A **handle** invite is in-app only (there's no address to email).
3. **They accept.** The invitee sees a **pending-invite banner** on their
   Overview the next time they sign in, plus a badge on the Organization nav
   item. Accepting adds them to the org; declining clears it.
4. **Manage.** From the same page an owner/admin can change a member's role,
   remove a member, revoke a pending invite, or (owner) rename/delete the org.
   Any member can **leave**.

### A note on how invites are secured

An invite is a *notification*, not access. When someone accepts, the new
membership row is bound to **their own verified identity** (`auth.uid()`), and
the invited email/handle is only ever used as a *match target*. So a forwarded
invite email can only be redeemed by the identity it was actually addressed to —
never by whoever happens to open the link.

---

## Seeing what's shared

- **Ownership badges.** In the Explorer, an org-owned lesson shows an
  **ownership badge** next to its scope badge; personal lessons show none.
- **Ownership filter.** The Explorer has an **All · Personal · {org}** filter so
  you can narrow the list to your personal lore or a specific org's.
- **Author & audience.** A lesson's detail panel shows its owning org, who last
  updated it (`@handle`), and how many members can see it.

## Writing org-owned lore

Agents write org-owned memories by passing the org slug on `memory.write` (the
`org` parameter — see [mcp-tools.md](./mcp-tools.md#memorywrite)). Ownership is
**authorization-derived on the server**: the write is accepted only if the
writer is a write-capable member of that org; it is never trusted from the
caller. The same applies to `memory.delete`.

### Scope → org binding (auto-routing)

Instead of naming the org on every write, an org **admin** can **bind a scope**
(e.g. a repo) to the org. Then any write under that scope with no explicit `org`
is routed to the org automatically:

- A **write-capable member** writing under a bound scope → the memory is
  org-owned, no `org` parameter needed.
- A **non-member** (or a viewer) writing under a bound scope → the memory is
  saved to **their personal lore** (never rejected), and `memory.write` returns
  a `notice` explaining it's saved personal because they aren't a write-member,
  and to ask an admin to add them. Never silent, never a hard failure.
- An **explicit `org`** parameter always takes precedence over the binding.

Binding is server-side truth (an `org_scope_bindings` row, globally unique per
scope — a scope maps to at most one org), not the advisory
`.lorekit/config.json`. Authorization to *create* a binding requires an
admin/owner role (`manage_scopes`).

**Settings → Shared scopes** (admin/owner): the dashboard lists the org's bound
scopes and lets you add or remove them. To bind a new scope, enter the scope
string (e.g. `repo::owner/name`) and click **Bind scope**. To remove one, click
**Unbind** and confirm. The Explorer's per-scope "shared with {org}" badge is a
planned fast-follow.

---

## Deleting an organization (and getting it back)

Deletion is **recoverable by design**. Deleting an org does **not** immediately
destroy anything:

1. **Delete = soft-delete.** The org and its shared lore disappear from every
   member's view immediately, but the data is retained and **recoverable for 30
   days** (`ORG_DELETE_RETENTION_DAYS`). The dashboard requires you to **type the
   org's name** to confirm, and offers an **"Export lore"** JSON download first.
2. **Purge = permanent.** A separate owner-only operation
   (`lorekit_org_purge`) performs the real, irreversible delete, cascading the
   org's memberships, invites, and shared memories away. This is the explicit
   permanent-delete path; there is no automated purge job yet, so the 30-day
   window is the intended retention period.

Under the hood, a soft-deleted org vanishes from all reads through a single
change to the tenant-visibility predicate — see
[architecture.md](./architecture.md#organizations).

---

## Invite emails

When you invite someone **by email**, LoreKit sends a transactional notification
email (via [Resend](https://resend.com)) that deep-links to the dashboard, where
they sign in with GitHub and accept. There's no magic-link token — the email is
just a nudge to the in-app flow.

Email is **optional and off until configured**. With no API key set, invites
still work exactly as before (in-app only), and the send simply no-ops — it can
never break the invite itself.

**To enable it** (operators), set two env vars in the web app (Vercel):

| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Your Resend API key. Unset → no emails, invites stay in-app. |
| `RESEND_FROM` | Verified sending address, e.g. `LoreKit <invites@yourdomain.com>`. |

You must **verify a sending domain in Resend** first. See
[deployment.md](./deployment.md) for the full env-var list. The send is
instrumented — a `lorekit.invite.email.send` span with an
`outcome` attribute (`sent` / `skipped_no_recipient` / `skipped_no_api_key` /
`error`) makes a failed or skipped send observable
([otel.md](./otel.md#invite-email-span)).
