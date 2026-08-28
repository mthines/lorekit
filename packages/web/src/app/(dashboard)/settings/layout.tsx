import { createServerClient } from '@/lib/supabase/server';
import { SettingsNav } from '@/components/settings/SettingsNav';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  // Only for `SettingsNav`'s developer-nav-visibility check (`isDeveloperEmail`)
  // — the dashboard layout has already gated auth for every route under here,
  // so this is purely "which email", not "is there a session at all".
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          API keys, your MCP endpoint, integrations, and your organization — all in one place.
        </p>
      </div>

      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <SettingsNav userEmail={user?.email ?? null} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}