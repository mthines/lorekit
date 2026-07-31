import Image from 'next/image';
import Link from 'next/link';

interface AuthCardProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

/**
 * Centered card shell for the standalone auth routes (forgot password, update
 * password). Deliberately plainer than the marketing login page — these pages
 * are a single task, so the only affordances are the form and a way back.
 */
export function AuthCard({ title, description, children }: AuthCardProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[var(--color-bg)] px-6 py-12">
      <Link href="/login" className="flex items-center gap-2.5" aria-label="LoreKit — back to sign in">
        <Image
          src="/icons/icon-192.png"
          alt=""
          aria-hidden
          width={32}
          height={32}
          className="shrink-0 rounded-xl"
          priority
        />
        <span className="text-sm font-semibold text-[var(--color-content-primary)]">LoreKit</span>
      </Link>

      <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-6 sm:p-8">
        <h1 className="text-lg font-semibold text-[var(--color-content-primary)]">{title}</h1>
        <p className="mt-1.5 text-sm text-[var(--color-content-secondary)]">{description}</p>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
