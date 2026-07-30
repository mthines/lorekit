import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/AuthCard';
import { UpdatePasswordForm } from '@/components/auth/UpdatePasswordForm';

export const metadata: Metadata = {
  title: 'Set a new password',
  description: 'Choose a new password for your LoreKit account.',
  robots: { index: false, follow: false },
};

export default function UpdatePasswordPage() {
  return (
    <AuthCard
      title="Set a new password"
      description="Choose a new password for your account. You'll be signed in straight away."
    >
      <UpdatePasswordForm />
    </AuthCard>
  );
}
