import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { Dash0Provider } from '@/components/providers/Dash0Provider';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg)] md:flex-row">
      {/* Pass userId so Dash0Provider can call identify() and attach
          the opaque user ID to all subsequent RUM telemetry */}
      <Dash0Provider userId={user.id} />
      <Sidebar user={user} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar user={user} />
        <main className="flex-1 overflow-y-auto p-4 pb-20 md:pb-6 md:p-6">{children}</main>
      </div>
    </div>
  );
}
