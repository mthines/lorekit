import { Suspense } from 'react';
import type { Metadata } from 'next';
import Image from 'next/image';
import { LoginButton } from '@/components/auth/LoginButton';
import { AuthHashCatcher } from '@/components/auth/AuthHashCatcher';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { BookOpen, Brain, GitBranch, Zap } from 'lucide-react';
import { TerminalTheater } from '@/components/landing/TerminalTheater';
import { CopyCommand } from '@/components/landing/CopyCommand';
import { GetStartedButton } from '@/components/learn/GetStartedButton';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Shared, persistent memory for AI coding agents.',
};

const FEATURES = [
  {
    icon: Brain,
    title: 'Agents that remember',
    description:
      'LoreKit gives your AI coding agents a shared memory store. Memories written in one session are available in the next — across repos, branches, and tools.',
  },
  {
    icon: GitBranch,
    title: 'Scope-aware memory',
    description:
      'Memories are namespaced by scope: global, project, repo, or branch. Agents read the narrowest scope first and fall back automatically.',
  },
  {
    icon: Zap,
    title: 'Wired to your workflow',
    description:
      'Connect via MCP in one config line. A GitHub webhook turns resolved PR review comments into candidate memories automatically.',
  },
  {
    icon: BookOpen,
    title: 'Browse and curate',
    description:
      'The dashboard lets you explore every memory your agents have written, archive stale entries, and watch activity in real time.',
  },
] as const;

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[var(--color-bg)]">
      {/*
        Renders nothing on an ordinary visit. Only fires when Supabase bounced
        an implicit-flow auth result to the Site URL (i.e. here) instead of the
        callback route — see AuthHashCatcher.
      */}
      <AuthHashCatcher />

      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div
          className="absolute left-1/2 top-1/3 size-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-30"
          style={{ background: 'radial-gradient(circle, #f5a623 0%, transparent 70%)' }}
        />
        <div
          className="absolute bottom-0 right-0 size-[500px] translate-x-1/4 translate-y-1/4 rounded-full opacity-10"
          style={{ background: 'radial-gradient(circle, #a78bfa 0%, transparent 70%)' }}
        />
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
      </div>

      <header className="relative z-10 flex h-16 items-center justify-between px-6 md:px-10">
        <div className="flex items-center gap-2.5">
          <Image
            src="/icons/icon-192.png"
            alt="LoreKit"
            width={32}
            height={32}
            className="shrink-0 rounded-xl"
            priority
          />
          <span className="text-sm font-semibold text-[var(--color-content-primary)]">LoreKit</span>
        </div>
        <div className="flex items-center gap-1 sm:gap-3">
          <a
            href="https://github.com/mthines/lorekit"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub"
            className="flex size-11 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors duration-200 hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            <svg
              aria-hidden
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="size-5"
            >
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </a>
          <Suspense fallback={null}>
            <LoginButton compact />
          </Suspense>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 flex flex-col items-center justify-center px-6 pt-12 pb-10">
        {/* Trust bar */}
        <div className="mb-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1 font-mono text-xs text-[var(--color-content-secondary)]">
            <span className="size-1.5 rounded-full bg-[var(--color-success)]" aria-hidden />
            Free
          </span>
          <a
            href="https://github.com/mthines/lorekit"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1 font-mono text-xs text-[var(--color-content-secondary)] transition-colors hover:text-[var(--color-content-primary)]"
          >
            <svg aria-hidden xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-3.5">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            Open source · MIT
          </a>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1 font-mono text-xs text-[var(--color-content-secondary)]">
            Works with Claude Code, Cursor &amp; Codex
          </span>
        </div>

        {/* Main headline */}
        <h1 className="mt-8 mb-3 max-w-2xl text-center text-3xl font-bold tracking-tight text-[var(--color-content-primary)] sm:text-4xl lg:text-5xl">
          Persistent memory
          <br />
          <span className="text-[var(--color-accent)]">for your AI agents</span>
        </h1>

        <p className="mb-8 max-w-lg text-center text-base text-[var(--color-content-secondary)]">
          Your AI agent forgets everything when a session ends. LoreKit gives it persistent memory —
          so it never asks the same question twice.
        </p>

        {/* Primary CTA */}
        <div className="flex flex-col items-center gap-3">
          <Suspense fallback={null}>
            <LoginButton />
          </Suspense>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            Sign in free · 2-minute setup
          </p>
        </div>
      </section>

      {/* Narrative sections */}
      <div className="relative z-10 flex flex-col items-center gap-16 px-6 py-12">
        <TerminalTheater />

        {/* Get started section — original concise card + link to full guide */}
        <div className="w-full max-w-2xl mx-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-[var(--color-content-primary)] mb-2 text-center">
            Get started in 2 minutes
          </h2>
          <p className="text-sm text-[var(--color-content-secondary)] text-center mb-6">
            Free · Open source
          </p>
          <ol className="space-y-4 mb-6">
            <li className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] font-mono text-xs font-semibold text-[var(--color-accent)]">1</span>
              <div>
                <p className="text-sm font-medium text-[var(--color-content-primary)] mb-1">Sign in and get your token</p>
                <p className="text-xs text-[var(--color-content-secondary)]">GitHub, email + password, or a magic link — takes 30 seconds</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] font-mono text-xs font-semibold text-[var(--color-accent)]">2</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--color-content-primary)] mb-1">Run one command</p>
                <CopyCommand command="npx @lorekit/cli install" />
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] font-mono text-xs font-semibold text-[var(--color-accent)]">3</span>
              <div>
                <p className="text-sm font-medium text-[var(--color-content-primary)] mb-1">Your agent now remembers</p>
                <p className="text-xs text-[var(--color-content-secondary)]">Memories persist across sessions, repos, and tools — automatically</p>
              </div>
            </li>
          </ol>
          {/* View full docs — client component owns dialog state; page stays server-rendered */}
          <GetStartedButton />
        </div>
      </div>

      {/* Feature cards */}
      <section
        aria-label="Features"
        className="relative z-10 mx-auto mb-20 grid max-w-4xl grid-cols-1 gap-4 px-6 sm:grid-cols-2"
      >
        {FEATURES.map(({ icon: Icon, title, description }) => (
          <div
            key={title}
            className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-6 transition-colors duration-200 hover:border-[var(--color-accent-glow)] hover:bg-[var(--color-bg-elevated)]"
          >
            <div className="flex size-10 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <Icon className="size-[18px] text-[var(--color-accent)]" aria-hidden />
            </div>
            <div>
              <h2 className="mb-1 text-sm font-semibold text-[var(--color-content-primary)]">
                {title}
              </h2>
              <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">
                {description}
              </p>
            </div>
          </div>
        ))}
      </section>

      <SiteFooter className="relative z-10" />
    </main>
  );
}
