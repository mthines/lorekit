/**
 * GitHub webhook handler.
 * Listens for pull_request_review_comment, pull_request_review,
 * pull_request_review_thread, and issue_comment events and creates
 * candidate memory entries tagged source::pr-webhook.
 *
 * Two signal-quality gates applied before every write:
 *   1. classifyWebhookAction — only 'created', 'submitted', and 'resolved'
 *      actions carry durable signal; edits, deletes, dismissals are skipped.
 *   2. isSignalWorthy — rejects short bodies, bot noise, and code-only blocks.
 *
 * All webhook-sourced memories are stored with a TTL — they are candidates, not
 * promoted lessons, and should decay unless re-surfaced. The number of days is
 * graded by the delivery's signal tier (webhookTtlDays, ./ttl-defaults.ts)
 * rather than flat, because gate 1 already knows a resolved thread outranks a
 * fresh comment.
 *
 * Unsupported event types return 200 OK but are marked with
 * lorekit.webhook.skipped=true on the span so they are visible in Dash0.
 *
 * Secret lookup strategy:
 *   1. Look up active webhook_secrets rows matching the delivery's
 *      repository.full_name directly (repo-scoped secrets). This is the
 *      primary path and is deterministic — no join on any user's GitHub
 *      login, so it works for org-owned repos where the owner login is the
 *      org, not any LoreKit user's personal login.
 *   2. Fall back to a null-`repo` legacy row (pre-dates per-repo secrets).
 *   3. Fall back to the GITHUB_WEBHOOK_SECRET env var for backwards
 *      compatibility (deployments that set the env var before the DB-backed
 *      flow was added).
 *
 * Security posture — pre-HMAC DB query:
 *   The repo full_name must be extracted from the payload before HMAC
 *   verification so the right per-repo secret can be selected. This is an
 *   accepted trade-off in a multi-tenant system where no single global
 *   secret exists. The attack surface is bounded by:
 *     a) SAFE_FULL_NAME regex — rejects anything that is not a plausible
 *        owner/repo before it touches a DB filter.
 *     b) 'none' short-circuit — if no secret is configured for the repo,
 *        the handler returns 401 immediately without attempting HMAC
 *        verification (no timing oracle on crypto).
 *     c) PostgREST eq filter — parameterised, not interpolated.
 *   An attacker can probe which repos have a secret configured, but cannot
 *   bypass HMAC verification or inject into the query.
 *
 * Previously this joined on repository.owner.login via an
 * auth.admin.listUsers({ perPage: 1000 }) scan — which fails for org-owned
 * repos (owner login is the org, not a personal login) and is O(all users),
 * capped at 1000. Matching by full_name against a stored `repo` column
 * removes both problems.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateScope } from '../_shared/scope/scope.ts';
import { sanitizeOrigin } from '../_shared/provenance/origin.ts';
import { traceRequest, type Span } from '../_shared/telemetry/otel.ts';
import { toolWrite } from './tools.ts';
import {
  selectWebhookSecrets,
  type WebhookSecretRow,
  type WebhookSecretSource,
} from './webhook-secret-select.ts';
import {
  mapInstallationEvent,
  reconcileInstallation,
} from './webhook-installation.ts';
import {
  buildRelevanceKey,
  buildRelevanceRecord,
  classifyMergedThread,
  classifyResolvedThread,
  extractMarkerValue,
  type RelevanceVerdict,
  type ThreadFacts,
} from './comment-relevance.ts';
import { fetchReviewThreads, TouchProbe } from './github-review-read.ts';
import { mintInstallationToken } from './github-app-client.ts';
import { webhookSignalTier, webhookTtlDays } from './ttl-defaults.ts';
import { nullableRpcArg, type DbClient } from '../_shared/db/db-client.ts';
import type { Database } from '../_shared/db/database.types.ts';

/** Delivery full_name must look like a plausible owner/repo before it touches a DB filter. */
const SAFE_FULL_NAME = /^[a-z0-9._/-]+$/;

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';

/**
 * GitHub App feature flag.  When GITHUB_APP_ENABLED is unset or any value
 * other than 'true', the App-event branch is completely inert — no token
 * minting, no reconcile, no App-secret lookup.  This keeps the live path
 * dormant until the App is registered and its secrets are provisioned.
 */
// ── Feature flags ───────────────────────────────────────────────────────────
const GITHUB_APP_ENABLED = Deno.env.get('GITHUB_APP_ENABLED') === 'true';

const SUPPORTED_EVENTS = new Set([
  'pull_request_review_comment',
  'pull_request_review',
  'pull_request_review_thread',
  'issue_comment',
]);

/**
 * Events the comment-relevance classifier needs that the candidate-write path
 * above does not.
 *
 * `pull_request` is here and NOT in SUPPORTED_EVENTS on purpose: the merge
 * sweep needs `closed`, but a pull_request delivery carries no comment body, so
 * routing it into the candidate write would produce nothing. Kept as its own
 * set so the two paths' event vocabularies stay independently readable.
 */
const RELEVANCE_ONLY_EVENTS = new Set(['pull_request']);

// ── Signal-quality helpers (inlined — Deno edge functions are self-contained) ─

type WebhookTier = 'WRITE' | 'SKIP';

const BOT_NOISE_PATTERNS: readonly RegExp[] = [
  /^(Build|Deploy|Test|CI|Checks?) (passed|failed|succeeded|completed)/i,
  /^Bumps \[/,
  /^All \d+ checks? (passed|failed)/i,
  /^Auto-merge enabled/i,
];

function classifyWebhookAction(event: string, action: string): WebhookTier {
  if (event === 'pull_request_review_thread' && action === 'resolved') return 'WRITE';
  if (event === 'pull_request_review' && action === 'submitted') return 'WRITE';
  if (event === 'pull_request_review_comment' && action === 'created') return 'WRITE';
  if (event === 'issue_comment' && action === 'created') return 'WRITE';
  return 'SKIP';
}

function isSignalWorthy(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length < 20) return false;
  if (/^```[\s\S]*```$/.test(trimmed)) return false;
  if (BOT_NOISE_PATTERNS.some((re) => re.test(trimmed))) return false;
  return true;
}

// ── Secret resolution ─────────────────────────────────────────────────────────

/**
 * Installation-lifecycle events delivered by the GitHub App.
 * These are verified against the single app-level secret and routed to
 * the reconcile shell rather than the comment-write path.
 */
const INSTALLATION_EVENTS = new Set([
  'installation',
  'installation_repositories',
  'installation_target',
  'github_app_authorization',
  'membership',
]);

/**
 * Resolve candidate HMAC secrets for this webhook delivery.
 *
 * When GITHUB_APP_ENABLED and the event is an App installation-lifecycle or
 * comment event: returns the single app-level secret from
 * GITHUB_APP_WEBHOOK_SECRET with source 'app'.
 *
 * Otherwise: queries active webhook_secrets rows matching the delivery's
 * full_name directly (repo-scoped, deterministic — no user-login join), falls
 * back to a legacy null-repo row, then to the GITHUB_WEBHOOK_SECRET env var.
 * See selectWebhookSecrets for the precedence and OTel source values.
 *
 * `fullName` must already be lowercased and pass the SAFE_FULL_NAME guard
 * before this is called — untrusted, pre-HMAC-verification input never
 * reaches a PostgREST filter unescaped.
 */
async function resolveSecrets(
  db: DbClient,
  fullName: string | undefined,
  event: string,
): Promise<{ secrets: string[]; source: WebhookSecretSource | 'app'; matchedRepo: string | null; isAppEvent: boolean }> {
  const isAppEvent = GITHUB_APP_ENABLED && (
    INSTALLATION_EVENTS.has(event) || SUPPORTED_EVENTS.has(event) || RELEVANCE_ONLY_EVENTS.has(event)
  );

  if (isAppEvent) {
    const appSecret = Deno.env.get('GITHUB_APP_WEBHOOK_SECRET') ?? '';
    return {
      secrets: appSecret ? [appSecret] : [],
      source: 'app',
      matchedRepo: null,
      isAppEvent: true,
    };
  }

  let rows: WebhookSecretRow[] = [];

  if (fullName && SAFE_FULL_NAME.test(fullName)) {
    const { data: repoRows } = await db
      .from('webhook_secrets')
      .select('secret, repo')
      .eq('active', true)
      .eq('repo', fullName);
    rows = (repoRows ?? []) as WebhookSecretRow[];

    if (rows.length === 0) {
      const { data: legacyRows } = await db
        .from('webhook_secrets')
        .select('secret, repo')
        .eq('active', true)
        .is('repo', null);
      rows = (legacyRows ?? []) as WebhookSecretRow[];
    }
  }

  const envSecret = Deno.env.get('GITHUB_WEBHOOK_SECRET') ?? '';
  const selection = selectWebhookSecrets(rows, fullName, envSecret);
  return { ...selection, isAppEvent: false };
}

/**
 * Reconcile an App installation event against the DB.
 *
 * Runs inside the App-event branch behind GITHUB_APP_ENABLED.  Maps the
 * (event, action) pair to a reconcile op (pure), looks up the GitHub account
 * id in auth.users to produce a ReconcileVerdict (pure), then calls the
 * SECURITY DEFINER upsert RPC (impure shell).
 *
 * Never throws — errors are logged as span attributes and the function returns
 * false to let the caller respond 200 OK (we never 5xx GitHub on reconcile
 * failures, to avoid delivery-retry storms).
 *
 */
async function reconcileAppInstallation(
  db: DbClient,
  event: string,
  // deno-lint-ignore no-explicit-any
  payload: Record<string, any>,
  span: Span,
): Promise<boolean> {
  const action = payload['action'] ?? 'unknown';
  const op = mapInstallationEvent(event, action);

  span.setAttributes({
    'lorekit.installation.op': op.kind,
    'lorekit.installation.event': event,
    'lorekit.installation.action': action,
  });

  if (op.kind === 'ignore') {
    span.setAttributes({ 'lorekit.installation.ignore_reason': op.reason });
    return true;
  }

  const installation = payload['installation'];
  if (!installation) {
    span.setAttributes({ 'lorekit.installation.skip_reason': 'no_installation_in_payload' });
    return true;
  }

  const installationId: number = installation['id'];
  const githubAccountId: number = installation['account']?.['id'];
  const githubAccountLogin: string = installation['account']?.['login'] ?? '';
  const accountType: string = installation['account']?.['type'] ?? 'User';

  if (!installationId || !githubAccountId) {
    span.setAttributes({ 'lorekit.installation.skip_reason': 'missing_ids' });
    return true;
  }

  if (op.kind === 'remove_installation') {
    const { error } = await db.rpc('lorekit_installation_remove', {
      p_installation_id: installationId,
    });
    if (error) {
      span.setAttributes({ 'lorekit.installation.remove_error': error.message });
    }
    return true;
  }

  // Resolve repos from payload for add/remove/upsert ops.
  const payloadRepos: string[] = (
    payload['repositories'] ??
    payload['repositories_added'] ??
    payload['repositories_removed'] ??
    []
  ).map((r: { full_name: string }) => (r.full_name ?? '').toLowerCase()).filter(Boolean);

  if (op.kind === 'remove_repos') {
    const { error } = await db.rpc('lorekit_installation_remove_repos', {
      p_installation_id: installationId,
      p_repos: payloadRepos,
    });
    if (error) {
      span.setAttributes({ 'lorekit.installation.remove_repos_error': error.message });
    }
    return true;
  }

  // upsert_installation or add_repos: look up the GitHub account id in
  // auth.identities (Supabase's identity provider table) to find the matching
  // LoreKit user.  We use a service-role RPC rather than querying auth.identities
  // directly through PostgREST (which does not expose the auth schema).
  // The db client here already uses the service-role key.
  // deno-lint-ignore no-explicit-any
  const { data: identityData } = await (db as any).rpc('lorekit_find_user_by_github_id', {
    p_github_account_id: String(githubAccountId),
  });

  const matchedUserId: string | null = identityData ?? null;
  const matchedUser = matchedUserId ? { userId: matchedUserId } : null;

  const verdict = reconcileInstallation(githubAccountId, matchedUser);

  span.setAttributes({
    'lorekit.installation.verdict': verdict.kind,
    'lorekit.installation.installation_id': installationId,
    'lorekit.installation.github_account_id': githubAccountId,
  });

  const { error: upsertError } = await db.rpc('lorekit_installation_upsert', {
    p_installation_id: installationId,
    p_github_account_id: githubAccountId,
    p_github_account_login: githubAccountLogin,
    p_account_type: accountType,
    p_user_id: nullableRpcArg(verdict.kind === 'linked' ? verdict.userId : null),
    p_status: verdict.kind,
    p_repos: payloadRepos,
  });

  if (upsertError) {
    span.setAttributes({ 'lorekit.installation.upsert_error': upsertError.message });
    span.error(`InstallationUpsertError: ${upsertError.message}`);
  }

  return true;
}

// ── Comment-relevance classification (GitHub App path) ───────────────────────

/**
 * One row of `lorekit_relevance_config_for_repo` — the four vocabulary fields
 * an installation declares, plus who the resulting records belong to.
 *
 * `user_id` is non-null by construction: the RPC filters on
 * `status = 'linked' and user_id is not null`, because a null-owner write lands
 * in the service-role partition that no user token can read back.
 */
interface RelevanceConfig {
  installation_id: number;
  user_id: string;
  marker_open: string;
  marker_close: string;
  bucket_tag: string;
  key_prefix: string;
  agent_name: string;
  record_kind: string;
  record_host: string | null;
  ttl_days: number;
}

/**
 * Records one delivery may write.  A merge sweep on a heavily-reviewed pull
 * request is the only realistic way to approach it, and stopping is better than
 * spending a user's whole memory cap in one webhook.
 */
const MAX_RELEVANCE_WRITES = 40;

/**
 * The two deliveries that carry a review outcome.
 *
 * A thread resolution is the direct signal.  A merge is the deadline: every
 * thread still open at that moment got its answer by never being answered.
 * Nothing else qualifies — a comment being POSTED says nothing about whether it
 * was any good, which is why the candidate feed and this classifier are
 * different mechanisms rather than two settings of one.
 */
function isRelevanceDelivery(
  event: string,
  action: string,
  // deno-lint-ignore no-explicit-any
  payload: Record<string, any>,
): boolean {
  if (event === 'pull_request_review_thread' && action === 'resolved') return true;
  // `closed` fires for both merge and abandon. An abandoned pull request never
  // shipped, so its open threads were not ignored — they were mooted, and a
  // suppression record for a change that never landed is trained on nothing.
  if (event === 'pull_request' && action === 'closed') return !!payload['pull_request']?.merged;
  return false;
}

/**
 * Classify the review outcomes one delivery reveals, and file each as a
 * relevance record.
 *
 * Never throws: this runs after a verified HMAC on a path that must answer 200,
 * and a classification failure is not a reason to make GitHub retry the
 * delivery.  Every refusal is recorded as a span attribute instead.
 */
async function classifyCommentRelevance(
  db: DbClient,
  event: string,
  // deno-lint-ignore no-explicit-any
  payload: Record<string, any>,
  span: Span,
): Promise<void> {
  const repo = String(payload['repository']?.full_name ?? '').toLowerCase();
  const pr = Number(payload['pull_request']?.number);
  if (!repo || !SAFE_FULL_NAME.test(repo) || !Number.isFinite(pr) || pr <= 0) {
    span.setAttributes({ 'lorekit.relevance.skip_reason': 'no_repo_or_pr' });
    return;
  }

  // The RPC is a 00102 addition, so it is absent from the generated Database
  // types — the same reason `lorekit_find_user_by_github_id` is called through
  // an untyped client above.
  // deno-lint-ignore no-explicit-any
  const { data: configRows, error: configError } = await (db as any).rpc(
    'lorekit_relevance_config_for_repo',
    { p_repo: repo },
  );
  if (configError) {
    span.setAttributes({ 'lorekit.relevance.config_error': configError.message });
    return;
  }
  const configs: RelevanceConfig[] = (configRows ?? []) as RelevanceConfig[];
  span.setAttributes({ 'lorekit.relevance.configs': configs.length });
  // Zero configs is the ordinary case, not a failure: the repository is not
  // covered, the installation is still pending, or the account has declared no
  // marker. All three mean there is nothing to classify for.
  if (configs.length === 0) return;

  const token = await mintInstallationToken(configs[0].installation_id);
  if (!token) {
    span.setAttributes({ 'lorekit.relevance.skip_reason': 'no_installation_token' });
    return;
  }

  const [owner, name] = repo.split('/');
  const read = await fetchReviewThreads({ token, owner, repo: name, pr });
  span.setAttributes({
    'lorekit.relevance.threads_read': read.threads.length,
    'lorekit.relevance.threads_complete': read.complete,
  });

  const isMergeSweep = event === 'pull_request';
  // A sweep asserts "this thread was open at merge" about every thread it does
  // NOT see, so an incomplete read makes the whole sweep unsound. A single
  // resolved thread asserts nothing about the others and is still classifiable.
  if (isMergeSweep && !read.complete) {
    span.setAttributes({ 'lorekit.relevance.skip_reason': 'thread_read_incomplete' });
    return;
  }

  const candidates = isMergeSweep
    ? read.threads
    : read.threads.filter((t) => t.rootCommentId === resolvedRootCommentId(payload));
  if (candidates.length === 0) {
    span.setAttributes({ 'lorekit.relevance.skip_reason': 'no_matching_thread' });
    return;
  }

  // Only the pull request's own author counts as a decline by reaction. A 👎
  // from a passer-by is not the author declining a finding, and reading it as
  // one lets anyone with a GitHub account suppress a finding class for a repo
  // they do not work on.
  const prAuthor: string | null = payload['pull_request']?.user?.login ?? null;
  const headSha: string = payload['pull_request']?.head?.sha ?? '';
  const probe = isMergeSweep ? new TouchProbe(token, repo, headSha) : null;
  const now = new Date().toISOString();

  let written = 0;
  const skips: string[] = [];

  for (const thread of candidates) {
    if (written >= MAX_RELEVANCE_WRITES) {
      skips.push('write-cap');
      break;
    }

    const config = configs.find(
      (c) => extractMarkerValue(thread.rootBody, c.marker_open, c.marker_close) !== null,
    );
    // No configured marker in the body: a human's comment, or another bot's.
    // Both are outside what this account asked to be classified.
    if (!config) continue;

    const markerValue = extractMarkerValue(thread.rootBody, config.marker_open, config.marker_close);
    const key = markerValue ? buildRelevanceKey(config.key_prefix, markerValue) : null;
    if (!markerValue || !key) continue;

    const facts: ThreadFacts = {
      state: { isResolved: thread.isResolved, isOutdated: thread.isOutdated },
      replies: thread.replies,
      thumbsDownBy:
        prAuthor && thread.thumbsDownLogins.includes(prAuthor) ? prAuthor : null,
      path: thread.rootPath,
      line: thread.rootLine,
      touch: probe ? await probe.evidenceFor(thread) : null,
    };

    const verdict: RelevanceVerdict = isMergeSweep
      ? classifyMergedThread(facts)
      : classifyResolvedThread(facts);

    if (!verdict.write) {
      skips.push(verdict.skip);
      continue;
    }

    const record = buildRelevanceRecord({
      verdict,
      markerValue,
      agentName: config.agent_name,
      commentAuthor: thread.rootAuthorLogin,
      commentAuthorIsBot: thread.rootAuthorIsBot,
      pr,
      repo,
      commentId: thread.rootCommentId,
      now,
      ttlDays: config.ttl_days,
    });

    try {
      await toolWrite(db, {
        scope: validateScope(`repo::${repo}`),
        key,
        value: JSON.stringify(record),
        ttl_days: config.ttl_days,
        tags: [config.bucket_tag, `source::${verdict.method}`],
        // LoreKit infers kind/host only from a `loop::` tag, so a bucket tagged
        // anything else must state them — which is why they are config fields.
        kind: config.record_kind,
        host: config.record_host ?? undefined,
        source_agent: 'github-app/comment-relevance',
        trigger: `${event}.${payload['action'] ?? 'unknown'}`,
        origin_repo: repo,
        origin_pr: pr,
        origin_commit: headSha || undefined,
      }, config.user_id, span);
      written++;
    } catch (err) {
      // A per-record failure (a memory cap, a malformed key) must not abandon
      // the rest of the sweep.
      skips.push(`write-failed:${(err as Error).name}`);
    }
  }

  span.setAttributes({
    'lorekit.relevance.written': written,
    'lorekit.relevance.mode': isMergeSweep ? 'merge-sweep' : 'thread-resolved',
    'lorekit.relevance.touch_compares': probe?.callCount ?? 0,
    ...(skips.length > 0 ? { 'lorekit.relevance.skips': skips.join(',') } : {}),
  });
}

/** The REST id of the resolved thread's root comment, from the delivery. */
// deno-lint-ignore no-explicit-any
function resolvedRootCommentId(payload: Record<string, any>): number | null {
  const id = payload['thread']?.comments?.[0]?.id;
  return typeof id === 'number' ? id : null;
}

/**
 * Verify a GitHub webhook HMAC-SHA256 signature using the Web Crypto API.
 *
 * Accepts the raw body bytes (not a decoded string) to avoid any encoding
 * round-trip loss. Returns a result object with diagnostic fields so the
 * caller can surface them as span attributes for observability.
 */
async function verifyHmac(
  bodyBytes: ArrayBuffer,
  signature: string | null,
  secret: string,
  /**
   * `'app'` is a real source — the single-secret GitHub App path — and
   * `resolveSecrets` above has always returned `WebhookSecretSource | 'app'`.
   * Only this parameter was narrower, so every App-event verification was a
   * type error that the untyped client had been absorbing.
   *
   * Widened here at the consumer rather than in `WebhookSecretSource` itself:
   * that type is byte-mirrored from `packages/mcp-core/src/webhook/webhook-secret-select.ts`
   * and enumerates the SECRET-SELECTION outcomes, which `'app'` is not one of.
   */
  secretSource: WebhookSecretSource | 'app',
): Promise<{ ok: boolean; secretConfigured: boolean; signaturePresent: boolean; secretSource: string; failReason?: string }> {
  const secretConfigured = secret.length > 0;
  const signaturePresent = !!signature && signature.length > 0;

  if (!signaturePresent) {
    return { ok: false, secretConfigured, signaturePresent, secretSource, failReason: 'no_signature_header' };
  }
  if (!secretConfigured) {
    return { ok: false, secretConfigured, signaturePresent, secretSource, failReason: 'secret_not_configured' };
  }
  if (!signature!.startsWith('sha256=')) {
    return { ok: false, secretConfigured, signaturePresent, secretSource, failReason: 'invalid_signature_format' };
  }

  const hexSig = signature!.slice(7);
  if (hexSig.length !== 64 || !/^[0-9a-f]+$/i.test(hexSig)) {
    return { ok: false, secretConfigured, signaturePresent, secretSource, failReason: 'invalid_signature_hex' };
  }

  const sigBytes = new Uint8Array(hexSig.match(/.{2}/g)!.map((h) => parseInt(h, 16)));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  // Verify directly over raw wire bytes — no text decode/re-encode round-trip
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, bodyBytes);
  return { ok, secretConfigured, signaturePresent, secretSource, failReason: ok ? undefined : 'hmac_mismatch' };
}

async function processWebhook(req: Request, span: Span): Promise<Response> {
  const event = req.headers.get('x-github-event') ?? 'unknown';
  const signature = req.headers.get('x-hub-signature-256');

  span.setAttributes({ 'lorekit.webhook.event': event });

  // Read body once as raw bytes; derive the string for JSON parsing from the
  // same buffer so both operations see identical byte content.
  const bodyBytes = await req.arrayBuffer();
  const body = new TextDecoder().decode(bodyBytes);

  // Parse enough of the payload to identify the repo before HMAC verification.
  // We need repository.full_name to look up the correct secret from the DB.
  // See security posture comment at the top of this file.
  // deno-lint-ignore no-explicit-any
  let earlyPayload: Record<string, any> = {};
  try { earlyPayload = JSON.parse(body); } catch { /* handled below */ }

  const fullNameRaw = earlyPayload['repository']?.full_name as string | undefined;
  const fullName = fullNameRaw?.toLowerCase();

  const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { secrets, source: secretSource, matchedRepo, isAppEvent } = await resolveSecrets(db, fullName, event);

  // Short-circuit: if no secret is configured (source 'none', or App path
  // selected but GITHUB_APP_WEBHOOK_SECRET is unset), reject immediately
  // without running any HMAC crypto. This avoids exposing a timing oracle on
  // the verification path and signals a configuration gap rather than a
  // signature mismatch.
  if (secrets.length === 0) {
    span.setAttributes({
      'lorekit.webhook.secret_configured': false,
      'lorekit.webhook.secret_source': secretSource,
      'lorekit.webhook.signature_present': !!signature,
      'lorekit.webhook.body_bytes': bodyBytes.byteLength,
      'lorekit.webhook.matched_repo': matchedRepo ?? '',
      'lorekit.webhook.hmac_fail_reason': 'secret_not_configured',
      'lorekit.webhook.is_app_event': isAppEvent,
    });
    // A 401: the delivery is unauthenticated because no secret is configured
    // for this repo. That is a caller/config condition, not a server fault, so
    // record it WITHOUT flipping the span to ERROR — an unconfigured or forged
    // delivery is expected in the wild and must not inflate the webhook error
    // rate. The `hmac_fail_reason` attribute keeps it queryable.
    span.clientError('HmacError: secret_not_configured');
    return new Response('Unauthorized', { status: 401 });
  }

  // Try each candidate secret in order. Single-user: one iteration.
  // Multi-user org: tries each until one verifies.
  let hmac = await verifyHmac(bodyBytes, signature, secrets[0], secretSource);
  for (let i = 1; i < secrets.length && !hmac.ok; i++) {
    hmac = await verifyHmac(bodyBytes, signature, secrets[i], secretSource);
  }

  // Always record diagnostic attributes — these are the ground truth for
  // debugging HMAC failures without guessing.
  span.setAttributes({
    'lorekit.webhook.secret_configured': hmac.secretConfigured,
    'lorekit.webhook.secret_source': hmac.secretSource,
    'lorekit.webhook.signature_present': hmac.signaturePresent,
    'lorekit.webhook.body_bytes': bodyBytes.byteLength,
    'lorekit.webhook.matched_repo': matchedRepo ?? '',
    'lorekit.webhook.is_app_event': isAppEvent,
  });

  if (!hmac.ok) {
    span.setAttributes({ 'lorekit.webhook.hmac_fail_reason': hmac.failReason ?? 'unknown' });
    // A 401 signature mismatch is a caller condition (a forged or misconfigured
    // delivery), not a server fault. Record it WITHOUT flipping the span to
    // ERROR so routine bad signatures do not inflate the webhook error rate;
    // `hmac_fail_reason` keeps the failure queryable.
    span.clientError(`HmacError: ${hmac.failReason ?? 'signature mismatch'}`);
    return new Response('Unauthorized', { status: 401 });
  }

  // App installation-lifecycle events: verified above, now reconcile.
  // Comment events (issue_comment/pull_request_review*) from the App flow
  // through the existing candidate-write path below — no special branch needed.
  if (isAppEvent && INSTALLATION_EVENTS.has(event)) {
    await reconcileAppInstallation(db, event, earlyPayload, span);
    return new Response('OK', { status: 200 });
  }

  // Comment-relevance classification. Runs BEFORE the candidate write below so
  // a resolved-thread delivery does both: the outcome is classified, and the
  // finding's text still lands in the raw candidate feed.
  //
  // Gated on the App because it needs an installation token to read the thread
  // state GitHub does not put in the delivery, and gated per-repository on a
  // config row existing — no new env var, and a repository that has declared
  // nothing is a no-op that costs one RPC.
  if (GITHUB_APP_ENABLED && isRelevanceDelivery(event, earlyPayload['action'] ?? 'unknown', earlyPayload)) {
    try {
      await classifyCommentRelevance(db, event, earlyPayload, span);
    } catch (err) {
      // Belt to classifyCommentRelevance's braces. A classification failure is
      // never a reason to 5xx a verified delivery and make GitHub retry it.
      const e = err as Error;
      span.setAttributes({ 'lorekit.relevance.error': `${e.name}: ${e.message}` });
    }
  }

  // A pull_request delivery carries no comment body, so it has nothing to
  // contribute to the candidate feed below and stops here.
  if (RELEVANCE_ONLY_EVENTS.has(event)) {
    return new Response('OK', { status: 200 });
  }

  // Report unsupported event types so they are visible in Dash0 rather than
  // silently discarded. We still return 200 OK — GitHub retries on 4xx/5xx
  // which would flood the delivery log for every push, star, etc.
  if (!SUPPORTED_EVENTS.has(event)) {
    span.setAttributes({
      'lorekit.webhook.skipped': true,
      'lorekit.webhook.skip_reason': 'unsupported_event',
    });
    return new Response('OK', { status: 200 });
  }

  try {
    const action = earlyPayload['action'] ?? 'unknown';
    const repo = earlyPayload['repository']?.full_name;
    span.setAttributes({ 'lorekit.webhook.action': action });

    if (!repo) return new Response('OK', { status: 200 });

    // Layer 1 — action-tier gate: skip edits, deletes, dismissals, etc.
    if (classifyWebhookAction(event, action) === 'SKIP') {
      span.setAttributes({
        'lorekit.webhook.skipped': true,
        'lorekit.webhook.skip_reason': 'action_not_signal_worthy',
      });
      return new Response('OK', { status: 200 });
    }

    let commentBody: string | undefined;
    let commentUrl: string | undefined;
    /**
     * GitHub's own id for the thing that was said, and the stable half of this
     * candidate's key. See the `key:` line below for why it is load-bearing.
     */
    let commentId: number | undefined;
    const extraTags: string[] = [];

    if (event === 'pull_request_review_comment') {
      commentBody = earlyPayload['comment']?.body;
      commentUrl = earlyPayload['comment']?.html_url;
      commentId = earlyPayload['comment']?.id;
    } else if (event === 'pull_request_review') {
      commentBody = earlyPayload['review']?.body;
      commentUrl = earlyPayload['review']?.html_url;
      commentId = earlyPayload['review']?.id;
    } else if (event === 'issue_comment') {
      commentBody = earlyPayload['comment']?.body;
      commentUrl = earlyPayload['comment']?.html_url;
      commentId = earlyPayload['comment']?.id;
    } else if (event === 'pull_request_review_thread') {
      // Resolved thread: the first comment in the thread is the finding.
      // This is the highest-signal event — explicit author acknowledgement.
      commentBody = earlyPayload['thread']?.comments?.[0]?.body;
      commentUrl = earlyPayload['thread']?.comments?.[0]?.html_url;
      commentId = earlyPayload['thread']?.comments?.[0]?.id;
      extraTags.push('signal::resolved-thread');
    }

    // Layer 2 — body quality gate: reject noise before touching the DB.
    if (!commentBody?.trim() || !isSignalWorthy(commentBody)) {
      span.setAttributes({ 'lorekit.webhook.skipped': true, 'lorekit.webhook.skip_reason': 'body_not_signal_worthy' });
      return new Response('OK', { status: 200 });
    }

    // Provenance: the delivery already carries the pull request this comment
    // belongs to, so record it as first-class origin instead of leaving the
    // link buried in an untyped `url::` tag. `issue_comment` on a PR reports
    // the number under `issue`; the three pull_request_* events under
    // `pull_request`. A comment on a plain issue has no `pull_request` key,
    // so `prNumber` stays undefined and no origin PR is recorded.
    const prNumber = earlyPayload['pull_request']?.number
      ?? (earlyPayload['issue']?.pull_request ? earlyPayload['issue']?.number : undefined);
    // Sanitised, not validated: a head branch is whatever the contributor
    // named it, so a field we cannot make sense of is dropped rather than
    // failing the whole ingest — the comment is the payload, the provenance is
    // decoration.
    const origin = sanitizeOrigin({
      origin_repo: repo,
      origin_pr: prNumber,
      origin_branch: earlyPayload['pull_request']?.head?.ref,
      origin_commit: earlyPayload['pull_request']?.head?.sha,
    });

    const scope = validateScope(`repo::${repo}`);
    span.setAttributes({ 'lorekit.scope': scope, 'lorekit.scope.type': 'repo' });

    // Layer 3 — TTL: webhook memories are candidates, not promoted lessons, so
    // they decay. How fast depends on the signal tier gate 1 already assigned;
    // the second argument of webhookTtlDays is where a per-repo override will be
    // threaded once it is configurable.
    const ttlDays = webhookTtlDays(event, action);
    span.setAttributes({
      'lorekit.webhook.signal_tier': webhookSignalTier(event, action),
      'lorekit.webhook.ttl_days': ttlDays,
    });

    await toolWrite(db, {
      scope,
      // Keyed by GitHub's own id for the comment, NOT by the arrival time.
      // This file's own header says these candidates "should decay unless
      // re-surfaced", and re-surfacing is a repeat write to the same key —
      // which `memory_write` answers by bumping `seen_count` and refreshing the
      // TTL. A `Date.now()` key made that unreachable by construction: every
      // delivery minted a key nothing could ever write to twice, so the one
      // signal separating a comment that mattered from one that did not was
      // permanently zero, and a redelivered webhook became a duplicate row.
      // Falls back to the timestamp only when the payload carries no id, which
      // keeps a shape-surprising delivery ingesting rather than dropping it.
      key: `pr-webhook::${repo}::${event}::${commentId ?? Date.now()}`,
      value: commentBody.trim(),
      ttl_days: ttlDays,
      tags: [
        'source::pr-webhook',
        `event::${event}`,
        `action::${action}`,
        ...extraTags,
        ...(commentUrl ? [`url::${commentUrl}`] : []),
      ],
      source_agent: 'github-webhook',
      trigger: `${event}.${action}`,
      ...origin,
    }, null, span);

    return new Response('OK', { status: 200 });
  } catch (err) {
    const e = err as Error;
    span.setAttributes({
      'lorekit.webhook.error.type': e.name,
      'lorekit.webhook.error.message': e.message,
    });
    span.error(`${e.name}: ${e.message}`);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export function handleWebhook(req: Request): Promise<Response> {
  return traceRequest(req, 'lorekit.webhook.github', (span) => processWebhook(req, span));
}
