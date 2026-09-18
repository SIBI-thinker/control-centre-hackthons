'use client';

import { useEffect, useState } from 'react';
import { BellOff, BellRing } from 'lucide-react';
import { disablePush, enablePush, getPushState, type PushState } from '@/lib/issues-api';

const HINT: Partial<Record<PushState, string>> = {
  unsupported: 'This browser can’t receive push notifications. On iPhone, add the site to your Home Screen first.',
  insecure: 'Push needs HTTPS — it will work through your Cloudflare Tunnel address.',
  denied: 'Notifications are blocked for this site. Allow them in the browser’s site settings.',
  unconfigured: 'Push is not configured on the server (VAPID keys missing).',
};

/** Turns issue push notifications on or off for this device. */
export function PushToggle() {
  const [state, setState] = useState<PushState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getPushState().then(setState).catch(() => setState('unsupported'));
  }, []);

  const toggle = async () => {
    setWorking(true);
    setError('');
    try {
      if (state === 'enabled') {
        setState(await disablePush());
      } else {
        const result = await enablePush();
        setState(result.state);
        if (result.error) setError(result.error);
      }
    } catch (err: any) {
      setError(err && err.message ? err.message : 'Could not change notification settings.');
    }
    setWorking(false);
  };

  if (state === null) return null;
  const blocked = state === 'unsupported' || state === 'insecure' || state === 'denied' || state === 'unconfigured';

  return (
    <div className="push-toggle">
      <button className={state === 'enabled' ? 'outline-action push-on' : 'outline-action'} onClick={toggle} disabled={working || blocked}>
        {state === 'enabled' ? <BellRing size={15} /> : <BellOff size={15} />}
        {working ? 'Working…' : state === 'enabled' ? 'Push on this device' : 'Enable push on this device'}
      </button>
      {(HINT[state] || error) && <span className="push-hint">{error || HINT[state]}</span>}
    </div>
  );
}
