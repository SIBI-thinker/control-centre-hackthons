'use client';

import { useState } from 'react';
import { Check, Copy, Wifi, WifiOff } from 'lucide-react';

export type ParticipantWifi = {
  ssid: string | null;
  ssid_password: string | null;
  instructions: string | null;
  username: string | null;
  password: string | null;
  source: 'personal' | 'team' | 'default' | null;
};

const SOURCE_NOTE: Record<string, string> = {
  personal: 'This login is yours alone.',
  team: 'Shared by your whole team.',
  default: 'The event-wide guest login.',
};

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard refused (insecure context or permission) — the value is on
      // screen anyway, so just skip the confirmation.
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="wifi-row">
      <span className="wifi-row-label">{label}</span>
      <code>{value}</code>
      <button onClick={copy} aria-label={'Copy ' + label} title={'Copy ' + label}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** The team's (or participant's) internet login. */
export function WifiCard({ wifi }: { wifi: ParticipantWifi | null }) {
  if (!wifi) return null;
  const hasLogin = Boolean(wifi.username && wifi.password);

  if (!hasLogin && !wifi.ssid && !wifi.ssid_password) {
    return (
      <section className="cyber-frame wifi-card">
        <div className="wifi-card-head">
          <WifiOff size={18} />
          <span className="eyebrow">VENUE WI-FI</span>
        </div>
        <p className="panel-hint" style={{ margin: 0 }}>No Wi-Fi details have been published yet.</p>
      </section>
    );
  }

  return (
    <section className="cyber-frame wifi-card">
      <div className="wifi-card-head">
        <Wifi size={18} />
        <span className="eyebrow">VENUE WI-FI</span>
        {wifi.source && <span className="wifi-source">{SOURCE_NOTE[wifi.source]}</span>}
      </div>

      {wifi.ssid && <CopyRow label="Network" value={wifi.ssid} />}
      {wifi.ssid_password && <CopyRow label="Wi-Fi password" value={wifi.ssid_password} />}
      {hasLogin ? (
        <>
          <CopyRow label="Username" value={wifi.username as string} />
          <CopyRow label="Password" value={wifi.password as string} />
        </>
      ) : (
        !wifi.ssid_password && (
          <p className="panel-hint">
            Your team doesn&apos;t have an internet login yet. Ask a volunteer or raise an issue below.
          </p>
        )
      )}

      {wifi.instructions && <p className="wifi-instructions">{wifi.instructions}</p>}
    </section>
  );
}
