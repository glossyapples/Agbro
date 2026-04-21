import { signOut } from '@/lib/auth/config';

export function SignOutButton() {
  async function doSignOut() {
    'use server';
    await signOut({ redirectTo: '/login' });
  }
  return (
    <form action={doSignOut}>
      <button
        type="submit"
        className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm font-medium text-ink-200 hover:border-ink-500"
      >
        Sign out
      </button>
    </form>
  );
}
