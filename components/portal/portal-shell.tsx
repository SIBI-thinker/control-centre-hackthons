'use client';

import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useBrand, useSession } from '@/lib/hooks';
import { BrandLockup } from '@/components/brand-lockup';
import { formatShortTime } from '@/lib/supabase';

/**
 * Frame for the participant and operator pages: brand, who is signed in, the
 * hard session countdown, and sign out.
 */
export function PortalShell({
  roleLabel,
  subtitle,
  children,
}: {
  roleLabel: string;
  subtitle?: string | null;
  children: React.ReactNode;
}) {
  const { session } = useSession();
  // Renaming the event mid-hackathon is not a thing that happens; checking for
  // it every 15 seconds on two thousand phones is.
  const brand = useBrand(null, 300000);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const msLeft = session ? session.expiresAt - now : null;
  const warning = msLeft !== null && msLeft > 0 && msLeft <= 5 * 60 * 1000;

  useEffect(() => {
    if (msLeft !== null && msLeft <= 0) window.location.href = '/login?reason=expired';
  }, [msLeft]);

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  return (
    <main className="portal-shell">
      <header className="portal-header">
        <BrandLockup brand={brand} subtitle={roleLabel + (subtitle ? ' · ' + subtitle : '')} />
        <div className="portal-user">
          {session && (
            <div className="portal-user-meta">
              <strong>{session.name}</strong>
              <span>
                {session.accountId}
                {msLeft !== null && msLeft > 0 ? ' · signed in for ' + formatShortTime(Math.floor(msLeft / 1000)) : ''}
              </span>
            </div>
          )}
          <button className="outline-action" onClick={signOut}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </header>

      {warning && (
        <div className="session-warning portal-banner" role="alert">
          <strong>Session ends in {formatShortTime(Math.floor((msLeft || 0) / 1000))}.</strong>
          <span>You&apos;ll need to sign in again with your ID and PIN.</span>
        </div>
      )}

      <div className="portal-content">{children}</div>
    </main>
  );
}
