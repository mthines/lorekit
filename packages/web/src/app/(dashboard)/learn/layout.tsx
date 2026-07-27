import { LearnNav } from '@/components/learn/LearnNav';

export default function LearnLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Start here</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Connect LoreKit to your agents, then go deeper with step-by-step guides for every setup.
        </p>
      </div>

      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <LearnNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
