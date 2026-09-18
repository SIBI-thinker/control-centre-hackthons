'use client';

import { useMemo } from 'react';
import { Download, Printer, ShieldAlert, X } from 'lucide-react';
import { downloadCsv, fileStamp } from '@/lib/download';
import { brandSlug } from '@/lib/brand';
import { useBrand } from '@/lib/hooks';
import type { IssuedCredential } from '@/lib/supabase';

/**
 * Shows freshly issued PINs. Only hashes are stored, so this is the one and
 * only time they can be seen — closing asks for confirmation.
 */
export function CredentialsSheet({
  credentials,
  title,
  onClose,
}: {
  credentials: IssuedCredential[];
  title: string;
  onClose: () => void;
}) {
  const brand = useBrand();
  const groups = useMemo(() => {
    const map = new Map<string, IssuedCredential[]>();
    credentials.forEach((c) => {
      const key = c.role === 'participant' ? c.team_name || 'No team' : c.role === 'operator' ? 'Room operators' : 'Core team';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    });
    return Array.from(map.entries());
  }, [credentials]);

  const handleClose = () => {
    if (confirm('These PINs will never be shown again. Have you printed or downloaded them?')) onClose();
  };

  const handleDownload = () => {
    const rows = [['id', 'name', 'role', 'pin', 'team', 'room']].concat(
      credentials.map((c) => [c.account_id, c.display_name, c.role, c.pin, c.team_name || '', c.room_label || ''])
    );
    downloadCsv(brandSlug(brand.name) + '-credentials-' + fileStamp() + '.csv', rows);
  };

  return (
    <div className="modal-backdrop">
      <div className="alert-modal credential-modal">
        <button className="modal-close" onClick={handleClose} aria-label="Close">
          <X size={18} />
        </button>
        <span className="eyebrow">CREDENTIALS — SHOWN ONCE</span>
        <h2>{title}</h2>

        <div className="credential-warning">
          <ShieldAlert size={16} />
          <span>
            PINs are stored only as one-way hashes. Print or download them now — the only way to see a PIN again is to
            reset it.
          </span>
        </div>

        <div className="credential-actions">
          <button className="primary-action" onClick={() => window.print()}>
            <Printer size={15} /> Print sheets
          </button>
          <button className="outline-action" onClick={handleDownload}>
            <Download size={15} /> Download CSV
          </button>
        </div>

        <div className="cyber-table-wrap credential-table-wrap">
          <table className="cyber-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>NAME</th>
                <th>PIN</th>
                <th>TEAM / ROOMS</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.account_id}>
                  <td><strong style={{ color: 'var(--white)' }}>{c.account_id}</strong></td>
                  <td>{c.display_name}</td>
                  <td className="credential-pin">{c.pin}</td>
                  <td>{c.team_name || c.room_label || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Print-only: one page per team, a cut-out card per person. */}
      <div className="credential-print-root">
        {groups.map(([group, people]) => (
          <section key={group} className="credential-print-group">
            <h1>{brand.name} — {group}</h1>
            <p>Sign in at the event site with your ID and PIN. Keep your PIN private.</p>
            <div className="credential-print-cards">
              {people.map((c) => (
                <div key={c.account_id} className="credential-print-card">
                  <div className="credential-print-name">{c.display_name}</div>
                  <div className="credential-print-row"><span>ID</span><strong>{c.account_id}</strong></div>
                  <div className="credential-print-row"><span>PIN</span><strong>{c.pin}</strong></div>
                  {c.room_label && <div className="credential-print-room">{c.room_label}</div>}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
