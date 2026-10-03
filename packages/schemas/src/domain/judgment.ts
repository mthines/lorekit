import { z } from 'zod';

/**
 * TypeSafe (Jev) judgment — the BYOK key management wire contract.
 *
 * `GET`/`POST`/`DELETE /memories/judgment-key` let a signed-in user store,
 * check, and remove their OWN TypeSafe API key so `GET /memories/relevant`
 * can rerank their shortlist with it (see `packages/mcp-core/src/judgment/judgment.ts`
 * for the pure scoring half, and `docs/judgment.md` for the endpoint contract
 * this was verified against).
 *
 * The key itself never appears in any response this schema describes —
 * `JudgmentKeyStatusResponseSchema` carries only `last4`, never the value —
 * matching the same "shown once, never again" posture as `webhook_secrets`
 * and `api_tokens`. The value is stored Vault-encrypted
 * (`supabase/migrations/00112_judgment_provider_keys.sql`) and decrypted only
 * by `_shared/judgment/judgment-keys.ts`, the one place it is ever read back.
 *
 * `requires: 'jwt'` on all three routes (not `'write'`/`'read'`): this is a
 * personal secret, not tenant data an `lk_*` API token should ever be able to
 * touch on a user's behalf — see `docs/decisions.md`'s "Judgment is BYOK,
 * best-effort, never on the correctness path".
 */

/** The one provider this ships with. A closed enum (not a bare string) so a
 *  future second provider is an additive schema change, not a free-text field
 *  the DB's own CHECK has to police alone. */
export const JUDGMENT_PROVIDERS = ['typesafe'] as const;
export const JudgmentProviderSchema = z.enum(JUDGMENT_PROVIDERS);
export type JudgmentProvider = z.infer<typeof JudgmentProviderSchema>;

/** Mirrors `judgment_provider_keys.status`'s CHECK. `rejected` is set by
 *  `lorekit_judgment_key_record_call` the first time TypeSafe answers 401/403,
 *  and self-heals back to `active` on any later non-`rejected` outcome —
 *  see the migration's `record_call` docblock for the version-guarded flip. */
export const JUDGMENT_KEY_STATUSES = ['active', 'rejected'] as const;
export const JudgmentKeyStatusSchema = z.enum(JUDGMENT_KEY_STATUSES);
export type JudgmentKeyStatus = z.infer<typeof JudgmentKeyStatusSchema>;

/**
 * `POST /memories/judgment-key` — store a new key, or rotate the existing one.
 *
 * The length bound is generous (TypeSafe's own keys are far shorter) rather
 * than tight: this value is opaque to LoreKit, so the honest validation is "not
 * empty, not absurd", not a format this package would have to keep in sync
 * with a third party's key format.
 */
export const SetJudgmentKeyBodySchema = z.object({
  api_key: z.string().min(8, 'api_key looks too short to be a real key').max(300),
  provider: JudgmentProviderSchema.optional().default('typesafe'),
});
export type SetJudgmentKeyBody = z.infer<typeof SetJudgmentKeyBodySchema>;

export const SetJudgmentKeyResponseSchema = z.object({
  configured: z.literal(true),
  /** Last 4 characters of the stored key, for the settings panel to confirm
   *  "yes, that's the one I just pasted" without ever re-displaying it. */
  last4: z.string(),
});
export type SetJudgmentKeyResponse = z.infer<typeof SetJudgmentKeyResponseSchema>;

/**
 * `GET /memories/judgment-key` — never carries the decrypted secret. Every
 * field below is null when `configured` is `false`, so a client can render
 * "not configured" off ONE field rather than treating four independent nulls
 * as four independent facts.
 */
export const JudgmentKeyStatusResponseSchema = z.object({
  configured: z.boolean(),
  provider: JudgmentProviderSchema.nullable(),
  last4: z.string().nullable(),
  status: JudgmentKeyStatusSchema.nullable(),
  calls_total: z.number().int().nullable(),
  created_at: z.string().nullable(),
});
export type JudgmentKeyStatusResponse = z.infer<typeof JudgmentKeyStatusResponseSchema>;

export const DeleteJudgmentKeyResponseSchema = z.object({
  /** `false` when there was nothing configured to delete — a no-op, not an error. */
  deleted: z.boolean(),
});
export type DeleteJudgmentKeyResponse = z.infer<typeof DeleteJudgmentKeyResponseSchema>;
