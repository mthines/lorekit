'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Key, Plus, Copy, CheckCheck, Eye, EyeOff, RefreshCw, Loader2, GitBranch,
  ShieldCheck, CircleCheck, TriangleAlert, Trash2,
} from 'lucide-react';
import {
  generateWebhookSecret,
  verifyWebhookSecret,
  deleteWebhookSecret,
  type WebhookSecret,
} from '@/lib/webhook-secrets';
import type { VerifyResult } from '@/lib/webhook-verify';
import { normalizeRepo } from '@/lib/repo-format';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Newly generated secret — shown once ──────────────────────────────────────

function NewSecretDisplay({
  secret,
  repo,
  onDismiss,
}: {
  secret: string;
  repo: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [visible, setVisible] = useState(true);

  function handleCopy() {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {
      // Clipboard access may be denied (permissions policy, non-HTTPS). Reveal
      // the secret and prompt a manual copy rather than failing silently.
      console.warn('[webhook-secret] clipboard write failed; falling back to manual copy');
      setVisible(true);
      setCopyError(true);
      setTimeout(() => setCopyError(false), 4000);
    });
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]"
    >
      <div className="h-0.5 w-full bg-[var(--color-accent)]" aria-hidden />
      <div className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <Key className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
          <p className="text-sm font-semibold text-[var(--color-content-primary)]">
            Secret for {repo} — copy it now
          </p>
        </div>
        <p className="mb-3 text-xs text-[var(--color-content-secondary)]">
          Paste it into GitHub&apos;s webhook &ldquo;Secret&rdquo; field below. It won&apos;t be shown again
          after you dismiss this.
        </p>

        <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg)] p-3">
          <code className={[
            'min-w-0 flex-1 overflow-x-auto font-mono text-xs text-[var(--color-content-primary)] select-all',
            !visible ? 'blur-sm select-none' : '',
          ].join(' ')}>
            {secret}
          </code>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? 'Hide secret' : 'Show secret'}
              className="flex size-11 items-center justify-center rounded text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]"
            >
              {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
            <button
              onClick={handleCopy}
              aria-label="Copy webhook secret"
              className="flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-subtle)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] transition-all duration-150 hover:bg-[var(--color-accent)] hover:text-[#000]"
            >
              {copied ? <><CheckCheck className="size-3" /> Copied!</> : <><Copy className="size-3" /> Copy</>}
            </button>
          </div>
        </div>

        {copyError && (
          <p className="mt-2 text-xs text-[var(--color-content-secondary)]">
            Couldn&apos;t copy automatically — select the secret above and press{' '}
            <kbd className="rounded border border-[var(--color-border)] px-1 font-mono">⌘/Ctrl+C</kbd>.
          </p>
        )}

        <button
          onClick={onDismiss}
          className="mt-3 text-xs text-[var(--color-content-tertiary)] underline hover:text-[var(--color-content-secondary)]"
        >
          I&apos;ve saved it, dismiss
        </button>
      </div>
    </motion.div>
  );
}

// ── Add-a-repo form ───────────────────────────────────────────────────────────

function AddRepoForm({
  onGenerated,
}: {
  onGenerated: (secret: string, record: WebhookSecret) => void;
}) {
  const [repo, setRepo] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const normalized = normalizeRepo(repo);
    if (!normalized) {
      setError('Invalid repo — expected the format "owner/name"');
      return;
    }

    startTransition(async () => {
      const result = await generateWebhookSecret(normalized);
      if ('error' in result) { setError(result.error); return; }
      onGenerated(result.secret, {
        id: result.id,
        secret: result.secret,
        repo: result.repo,
        active: true,
        created_at: new Date().toISOString(),
      });
      setRepo('');
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <p className="text-xs font-medium text-[var(--color-content-secondary)]">Add a repo</p>

      <input
        ref={inputRef}
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        placeholder="owner/repo"
        maxLength={200}
        required
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm text-[var(--color-content-primary)] placeholder:font-sans placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
      />

      {error && <p className="text-xs text-[var(--color-error)]">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !repo.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[#000] transition-opacity duration-150 disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Key className="size-4" />}
          Generate secret
        </button>
      </div>
    </form>
  );
}

// ── Repo secret row ───────────────────────────────────────────────────────────

function RepoSecretRow({
  webhookSecret,
  onRegenerate,
  onDeleted,
}: {
  // A rendered row always has a repo — legacy null-repo rows are filtered out
  // before we get here (see WebhookSecretManager).
  webhookSecret: WebhookSecret & { repo: string };
  onRegenerate: (secret: string, record: WebhookSecret) => void;
  onDeleted: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');

  const [verifying, startVerify] = useTransition();
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const [deleting, startDelete] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(webhookSecret.secret).then(() => {
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Clipboard access may be denied (permissions policy, non-HTTPS). Reveal
      // the secret and prompt a manual copy rather than failing silently.
      console.warn('[webhook-secret] clipboard write failed; falling back to manual copy');
      setVisible(true);
      setCopyError(true);
      setTimeout(() => setCopyError(false), 4000);
    });
  }

  function handleRegenerate() {
    setError('');
    setVerifyResult(null);
    startTransition(async () => {
      const result = await generateWebhookSecret(webhookSecret.repo);
      if ('error' in result) { setError(result.error); return; }
      onRegenerate(result.secret, {
        id: result.id,
        secret: result.secret,
        repo: result.repo,
        active: true,
        created_at: new Date().toISOString(),
      });
    });
  }

  function handleVerify() {
    setError('');
    setVerifyResult(null);
    startVerify(async () => {
      setVerifyResult(await verifyWebhookSecret(webhookSecret.repo));
    });
  }

  function handleDelete() {
    setError('');
    startDelete(async () => {
      const result = await deleteWebhookSecret(webhookSecret.id);
      if (result.error) { setError(result.error); setConfirmDelete(false); return; }
      onDeleted(webhookSecret.id);
    });
  }

  return (
    <motion.div
      layout
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2.5"
    >
      <div className="flex items-center gap-3">
        <GitBranch className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <span className="font-mono text-sm font-medium text-[var(--color-content-primary)]">
            {webhookSecret.repo}
          </span>
          <div className="mt-0.5 text-[10px] text-[var(--color-content-tertiary)]">
            Created {relativeTime(webhookSecret.created_at)}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
        <code className={[
          'min-w-0 flex-1 overflow-x-auto font-mono text-xs text-[var(--color-content-secondary)]',
          !visible ? 'blur-sm select-none' : '',
        ].join(' ')}>
          {webhookSecret.secret}
        </code>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide secret' : 'Show secret'}
            className="flex size-8 items-center justify-center rounded text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]"
          >
            {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            onClick={handleCopy}
            aria-label={`Copy secret for ${webhookSecret.repo}`}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {copied ? <><CheckCheck className="size-3" /> Copied!</> : <><Copy className="size-3" /> Copy</>}
          </button>
          <button
            onClick={handleRegenerate}
            disabled={pending}
            aria-label={`Regenerate secret for ${webhookSecret.repo}`}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            Regenerate
          </button>
        </div>
      </div>

      {/* Verify + Delete actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={handleVerify}
          disabled={verifying}
          aria-label={`Verify webhook for ${webhookSecret.repo}`}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {verifying ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />}
          {verifying ? 'Verifying…' : 'Verify'}
        </button>

        <div className="flex-1" />

        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[var(--color-content-tertiary)]">Delete this secret?</span>
            <button
              onClick={handleDelete}
              disabled={deleting}
              aria-label={`Confirm delete secret for ${webhookSecret.repo}`}
              className="flex items-center gap-1 rounded-md border border-[var(--color-error)] px-2 py-0.5 text-xs font-medium text-[var(--color-error)] transition-colors duration-150 hover:bg-[var(--color-error)] hover:text-[#000] disabled:opacity-50"
            >
              {deleting ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-secondary)] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            aria-label={`Delete secret for ${webhookSecret.repo}`}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:border-[var(--color-error)] hover:text-[var(--color-error)]"
          >
            <Trash2 className="size-3" />
            Delete
          </button>
        )}
      </div>

      {/* Verify result */}
      <AnimatePresence>
        {verifyResult && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            role="status"
            className={[
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
              verifyResult.ok
                ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-content-secondary)]'
                : 'border-[var(--color-error)]/40 bg-[var(--color-error)]/10 text-[var(--color-content-secondary)]',
            ].join(' ')}
          >
            {verifyResult.ok
              ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--color-success)]" aria-hidden />
              : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--color-error)]" aria-hidden />}
            <span>{verifyResult.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {copyError && (
        <p className="text-xs text-[var(--color-content-secondary)]">
          Couldn&apos;t copy automatically — select the secret and press{' '}
          <kbd className="rounded border border-[var(--color-border)] px-1 font-mono">⌘/Ctrl+C</kbd>.
        </p>
      )}
      {error && <p className="text-xs text-[var(--color-error)]">{error}</p>}
    </motion.div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface WebhookSecretManagerProps {
  initialSecrets: WebhookSecret[];
}

export function WebhookSecretManager({ initialSecrets }: WebhookSecretManagerProps) {
  // Webhook secrets are per-repo. Any null-repo row is a leftover from before
  // repo scoping existed — it isn't part of the current setup flow, so we don't
  // surface it. Every displayed secret therefore has a concrete owner/repo.
  const repoSecrets = initialSecrets.filter(
    (s): s is WebhookSecret & { repo: string } => Boolean(s.repo),
  );
  const [secrets, setSecrets] = useState<Array<WebhookSecret & { repo: string }>>(repoSecrets);
  const [showForm, setShowForm] = useState(repoSecrets.length === 0);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [newSecretRepo, setNewSecretRepo] = useState<string | null>(null);

  function handleGenerated(secret: string, record: WebhookSecret) {
    // The generate action always returns a concrete repo; guard for the type
    // narrowing and skip the (impossible) null-repo case rather than widening
    // the per-repo list.
    if (!record.repo) {
      // Unreachable in practice — generateWebhookSecret always returns a repo —
      // but surface it rather than leaving the form silently open.
      console.warn('[webhook-secret] generated secret had no repo; skipping list update');
      return;
    }
    const withRepo = { ...record, repo: record.repo };
    setSecrets((prev) => [withRepo, ...prev.filter((s) => s.repo !== withRepo.repo)]);
    setNewSecret(secret);
    setNewSecretRepo(withRepo.repo);
    setShowForm(false);
  }

  function handleDeleted(id: string) {
    setSecrets((prev) => prev.filter((s) => s.id !== id));
  }

  function handleDismissNewSecret() {
    setNewSecret(null);
    setNewSecretRepo(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* New secret banner */}
      <AnimatePresence>
        {newSecret && newSecretRepo && (
          <NewSecretDisplay secret={newSecret} repo={newSecretRepo} onDismiss={handleDismissNewSecret} />
        )}
      </AnimatePresence>

      {/* Add-a-repo form */}
      <AnimatePresence>
        {showForm && (
          <motion.div
            key="form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <AddRepoForm onGenerated={handleGenerated} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Repo secret list */}
      {secrets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
            Your repo secrets
          </p>
          <AnimatePresence>
            {secrets.map((s) => (
              <RepoSecretRow
                key={s.id}
                webhookSecret={s}
                onRegenerate={handleGenerated}
                onDeleted={handleDeleted}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Add another repo */}
      {!showForm && !newSecret && (
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 self-start rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2 text-sm text-[var(--color-content-secondary)] transition-all duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus className="size-4" aria-hidden />
          Add another repo
        </button>
      )}
    </div>
  );
}
