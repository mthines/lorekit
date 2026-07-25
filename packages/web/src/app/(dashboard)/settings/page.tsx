import { redirect } from 'next/navigation';

// /settings has no content of its own — it lands on the first section.
export default function SettingsIndexPage() {
  redirect('/settings/api-keys');
}
