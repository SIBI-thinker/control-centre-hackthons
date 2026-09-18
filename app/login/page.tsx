'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck, Loader2, Lock } from 'lucide-react';
import { BrandLockup } from '@/components/brand-lockup';
import { useBrand } from '@/lib/hooks';

const REASONS: Record<string, string> = {
  expired: 'Your session ended. Sign in again to continue.',
  misconfigured: 'Sign-in is unavailable: the server is missing its session secret. Contact the core team.',
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reason = searchParams.get('reason');

  const brand = useBrand();
  const [accountId, setAccountId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    let res: Response;
    try {
      res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accountId.trim(), pin }),
      });
    } catch {
      setError('Network error — check the connection and try again.');
      setLoading(false);
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok && data.redirect) {
      router.push(data.redirect);
      router.refresh();
      return;
    }

    setError(data.error || 'Sign-in failed.');
    setPin('');
    setLoading(false);
  };

  return (
    <main className="login-shell">
      <div className="login-grid" />
      <form className="login-card" onSubmit={handleSubmit}>
        <BrandLockup brand={brand} subtitle="CONTROL CENTER ACCESS" className="login-brand" markClassName="login-mark" />
        <div className="login-icon"><Lock size={22} /></div>
        <h1>Sign in</h1>
        <p>Use the ID and PIN you were given — core team, room operators, and participants all sign in here.</p>

        {reason && REASONS[reason] && !error && <div className="login-notice">{REASONS[reason]}</div>}

        <label>
          <span>YOUR ID</span>
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value.toUpperCase())}
            placeholder="e.g. ADM-SIBI"
            autoFocus
            autoComplete="username"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
          />
        </label>
        <label>
          <span>PIN</span>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••••"
            autoComplete="current-password"
            maxLength={12}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={loading || !accountId.trim() || pin.length < 6} className="login-submit">
          {loading ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
          {loading ? 'Verifying...' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary so the page can still be
  // statically rendered.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
