import { SettingsNav } from '@/components/settings/SettingsNav';
import { createServerClient } from '@/lib/supabase/server';
import { UserMenu } from '@/components/auth/UserMenu';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          API keys, your MCP endpoint, the GitHub webhook, and your organization — all in one place.
        </p>
      </div>

      {/* User menu — only rendered on mobile (<md). On md+ the sidebar footer already shows it. */}
      {user && (
        <div className="md:hidden">
          <UserMenu user={user} />
        </div>
      )}

      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}