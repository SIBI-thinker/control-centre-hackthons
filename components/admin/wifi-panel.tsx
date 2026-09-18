'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileUp, Plus, Save, Search, Shuffle, Trash2, Upload, Wifi, X } from 'lucide-react';
import {
  addWifiCredential,
  allotWifi,
  deleteWifiCredential,
  importWifiFile,
  importWifiText,
  saveWifiSettings,
  updateWifiCredential,
  useWifi,
  type WifiImportResult,
} from '@/lib/admin-api';
import { duplicateTeamNames, teamLabel } from '@/lib/teams';

const SAMPLE = 'guest01,Pass@123\nguest02,Pass@456\n\nor:  Username: guest03  Password: Pass@789';

export function WifiPanel() {
  const { wifi, refetch } = useWifi();
  const dupTeamNames = useMemo(() => duplicateTeamNames(wifi?.teams ?? []), [wifi]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // settings
  const [ssid, setSsid] = useState('');
  const [ssidPassword, setSsidPassword] = useState('');
  const [instructions, setInstructions] = useState('');
  const [defaultUser, setDefaultUser] = useState('');
  const [defaultPass, setDefaultPass] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // add one
  const [newUser, setNewUser] = useState('');
  const [newPass, setNewPass] = useState('');

  // import
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WifiImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  const [search, setSearch] = useState('');

  useEffect(() => {
    if (settingsLoaded) return;
    if (wifi.stats.total > 0 || wifi.settings.ssid !== null || wifi.teams.length > 0) {
      setSsid(wifi.settings.ssid || '');
      setSsidPassword(wifi.settings.ssid_password || '');
      setInstructions(wifi.settings.instructions || '');
      setDefaultUser(wifi.settings.default_username || '');
      setDefaultPass(wifi.settings.default_password || '');
      setSettingsLoaded(true);
    }
  }, [wifi, settingsLoaded]);

  const run = async (fn: () => Promise<{ error: { message: string } | null }>, success?: string) => {
    setBusy(true);
    const { error: apiError } = await fn();
    setBusy(false);
    setError(apiError ? apiError.message : '');
    setNotice(!apiError && success ? success : '');
    if (!apiError) refetch();
    return !apiError;
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return wifi.credentials;
    return wifi.credentials.filter(
      (c) => c.username.toLowerCase().includes(q) || (c.assigned_to ? c.assigned_to.label.toLowerCase().includes(q) : 'unassigned'.includes(q))
    );
  }, [wifi.credentials, search]);

  const runPreview = async (commit: boolean) => {
    setImporting(true);
    setError('');
    const result = importFile ? await importWifiFile(importFile, commit) : await importWifiText(importText, commit);
    setImporting(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    const data = result.data as WifiImportResult;
    if (data.committed) {
      setImportOpen(false);
      setPreview(null);
      setImportText('');
      setImportFile(null);
      setNotice('Imported ' + (data.imported ?? 0) + ' login(s).');
      refetch();
      return;
    }
    setPreview(data);
    // A PDF's text is shown so it can be corrected by hand if the read went wrong.
    if (importFile && data.extracted_text && data.logins.length === 0) setImportText(data.extracted_text);
  };

  const blocked = preview
    ? preview.duplicates.length > 0 ||
      preview.conflicts.length > 0 ||
      preview.unknown.length > 0 ||
      (preview.ambiguous ?? []).length > 0 ||
      preview.logins.length === 0
    : true;

  return (
    <div className="view-container">
      <div className="overview-intro">
        <div>
          <span className="eyebrow">VENUE WI-FI</span>
          <p>
            Each team (or each participant) gets an internet login, shown on their own page. The network name is the same
            everywhere, so it is set once here.
          </p>
        </div>
        <button className="outline-action" onClick={() => { setImportOpen(true); setPreview(null); }}>
          <FileUp size={16} /> Import logins
        </button>
      </div>

      {error && <div className="action-error"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button></div>}
      {notice && <div className="import-summary good"><span>{notice}</span></div>}

      <section className="cyber-frame">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">NETWORK</span>
            <h2>Shared settings</h2>
          </div>
          <Wifi size={20} />
        </div>
        <div className="inline-form">
          <label className="field">
            <span>Network name (SSID)</span>
            <input value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={64} placeholder="KPRIET-GUEST" />
          </label>
          <label className="field">
            <span>Wi-Fi password</span>
            <input
              value={ssidPassword}
              onChange={(e) => setSsidPassword(e.target.value)}
              maxLength={120}
              placeholder="the passphrase for joining"
            />
          </label>
          <label className="field">
            <span>Default username (optional)</span>
            <input value={defaultUser} onChange={(e) => setDefaultUser(e.target.value)} maxLength={120} placeholder="for anyone without their own" />
          </label>
          <label className="field">
            <span>Default password (optional)</span>
            <input value={defaultPass} onChange={(e) => setDefaultPass(e.target.value)} maxLength={120} />
          </label>
        </div>
        <label className="field" style={{ marginTop: 12 }}>
          <span>How to connect (shown to participants)</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder={'e.g. Connect to the network, open any page, then sign in on the portal with the details above.'}
            style={{ padding: '9px 11px', background: 'var(--ink)', border: '1px solid var(--line)', color: 'var(--white)', fontSize: 13 }}
          />
        </label>
        <button
          className="primary-action"
          style={{ marginTop: 12 }}
          disabled={busy}
          onClick={() =>
            run(
              () =>
                saveWifiSettings({
                  ssid,
                  ssid_password: ssidPassword,
                  instructions,
                  default_username: defaultUser,
                  default_password: defaultPass,
                }),
              'Network settings saved.'
            )
          }
        >
          <Save size={15} /> Save settings
        </button>
        {defaultUser && defaultPass && (
          <p className="panel-hint">
            Every participant without their own or a team login will see this default — including teams you haven&apos;t
            allotted yet.
          </p>
        )}
      </section>

      <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <section className="cyber-frame">
          <div className="small-metric-label"><Wifi size={16} /> LOGINS</div>
          <div className="stat-value">{wifi.stats.total}</div>
          <div className="stat-caption">{wifi.stats.unassigned} unassigned</div>
        </section>
        <section className="cyber-frame">
          <div className="small-metric-label">TEAMS WAITING</div>
          <div className="stat-value" style={{ color: wifi.stats.teams_without ? 'var(--amber)' : 'var(--green)' }}>{wifi.stats.teams_without}</div>
          <div className="stat-caption">teams with no login</div>
        </section>
        <section className="cyber-frame">
          <div className="small-metric-label">PARTICIPANTS WAITING</div>
          <div className="stat-value">{wifi.stats.participants_without}</div>
          <div className="stat-caption">only matters for per-person logins</div>
        </section>
        <section className="cyber-frame">
          <div className="small-metric-label"><Shuffle size={16} /> ALLOT</div>
          <div className="row-actions" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <button
              className="outline-action"
              disabled={busy || wifi.stats.unassigned === 0}
              onClick={async () => {
                if (!confirm('Give one unassigned login to each team that has none?')) return;
                const { data, error: apiError } = await allotWifi('teams');
                setError(apiError ? apiError.message : '');
                if (data) setNotice('Allotted ' + data.allotted + ' login(s)' + (data.shortfall ? ' — ' + data.shortfall + ' team(s) still waiting, import more.' : '.'));
                refetch();
              }}
            >
              Per team
            </button>
            <button
              className="outline-action"
              disabled={busy || wifi.stats.unassigned === 0}
              onClick={async () => {
                if (!confirm('Give one unassigned login to each participant who has none?')) return;
                const { data, error: apiError } = await allotWifi('participants');
                setError(apiError ? apiError.message : '');
                if (data) setNotice('Allotted ' + data.allotted + ' login(s)' + (data.shortfall ? ' — ' + data.shortfall + ' participant(s) still waiting.' : '.'));
                refetch();
              }}
            >
              Per person
            </button>
          </div>
          <div className="stat-caption">fills gaps only; never moves an existing login</div>
        </section>
      </div>

      <section className="cyber-frame">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">POOL</span>
            <h2>Logins</h2>
          </div>
        </div>

        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => addWifiCredential({ username: newUser, password: newPass }), 'Login added to the pool.');
            if (ok) {
              setNewUser('');
              setNewPass('');
            }
          }}
        >
          <label className="field">
            <span>Username</span>
            <input value={newUser} onChange={(e) => setNewUser(e.target.value)} maxLength={120} required />
          </label>
          <label className="field">
            <span>Password</span>
            <input value={newPass} onChange={(e) => setNewPass(e.target.value)} maxLength={120} required />
          </label>
          <button type="submit" className="primary-action" disabled={busy || !newUser.trim() || !newPass.trim()}>
            <Plus size={15} /> Add
          </button>
        </form>

        <div className="table-toolbar" style={{ marginTop: 14 }}>
          <label className="search-field">
            <Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search username or who has it" />
          </label>
          <span className="panel-hint" style={{ margin: 0 }}>{filtered.length} shown</span>
        </div>

        <div className="cyber-table-wrap">
          <table className="cyber-table">
            <thead>
              <tr>
                <th>USERNAME</th>
                <th>PASSWORD</th>
                <th>GIVEN TO</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td><strong style={{ color: 'var(--white)' }}>{c.username}</strong></td>
                  <td className="wifi-password">{c.password}</td>
                  <td>
                    <select
                      className="inline-batch-select"
                      value={c.assigned_team_id ? 'team:' + c.assigned_team_id : c.assigned_account_id ? 'person:' + c.assigned_account_id : ''}
                      onChange={(e) => {
                        const [kind, id] = e.target.value.split(':');
                        const updates = kind === 'team'
                          ? { assigned_team_id: id, assigned_account_id: null }
                          : kind === 'person'
                          ? { assigned_account_id: id, assigned_team_id: null }
                          : { assigned_team_id: null, assigned_account_id: null };
                        run(() => updateWifiCredential(c.id, updates));
                      }}
                    >
                      <option value="">— unassigned —</option>
                      <optgroup label="Teams">
                        {wifi.teams.map((t) => (
                          <option key={t.id} value={'team:' + t.id}>
                            {teamLabel(t, dupTeamNames)}{t.has_wifi && t.id !== c.assigned_team_id ? ' (has one)' : ''}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Participants">
                        {wifi.participants.map((p) => (
                          <option key={p.id} value={'person:' + p.id}>{p.account_id} · {p.display_name}</option>
                        ))}
                      </optgroup>
                    </select>
                  </td>
                  <td>
                    <button
                      className="icon-danger"
                      disabled={busy}
                      onClick={() => {
                        if (confirm('Delete login ' + c.username + '?')) run(() => deleteWifiCredential(c.id));
                      }}
                      title="Delete login"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={4} className="empty-cell">No logins yet. Import a list, or add one above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {wifi.stats.teams_without > 0 && wifi.stats.unassigned > 0 && (
          <p className="panel-hint">{wifi.stats.teams_without} team(s) have no login and {wifi.stats.unassigned} are unassigned — use “Per team” above.</p>
        )}
      </section>

      {importOpen && (
        <div className="modal-backdrop">
          <div className="alert-modal credential-modal">
            <button className="modal-close" onClick={() => { setImportOpen(false); setPreview(null); }}><X size={18} /></button>
            <span className="eyebrow">IMPORT LOGINS</span>
            <h2>From a PDF, CSV, or pasted list</h2>
            <p>
              Most layouts are understood: <code>user,pass</code>, <code>user pass</code>, or
              <code> Username: … Password: …</code>. Nothing is saved until you confirm what was read.
            </p>

            <div className="import-inputs">
              <label className="outline-action file-picker">
                <Upload size={15} /> {importFile ? importFile.name : 'Choose PDF or CSV'}
                <input
                  type="file"
                  accept=".pdf,.csv,.txt,application/pdf,text/csv,text/plain"
                  onChange={(e) => {
                    setImportFile(e.target.files?.[0] || null);
                    setPreview(null);
                  }}
                />
              </label>
              {importFile && (
                <button className="inline-dismiss" onClick={() => { setImportFile(null); setPreview(null); }}>Clear file</button>
              )}
              <span className="panel-hint" style={{ margin: 0 }}>or paste below</span>
            </div>

            <textarea
              className="import-textarea"
              rows={7}
              value={importText}
              onChange={(e) => { setImportText(e.target.value); setPreview(null); }}
              placeholder={SAMPLE}
              spellCheck={false}
              disabled={Boolean(importFile)}
            />

            <div className="import-actions">
              <button className="outline-action" disabled={importing || (!importText.trim() && !importFile)} onClick={() => runPreview(false)}>
                {importing ? 'Reading…' : 'Read list'}
              </button>
              <button className="primary-action" disabled={importing || blocked} onClick={() => runPreview(true)}>
                {preview ? 'Import ' + preview.logins.length + ' login(s)' : 'Import'}
              </button>
            </div>

            {preview && (
              <>
                {preview.logins.length === 0 ? (
                  <div className="import-summary bad">
                    <span>
                      No logins could be read{preview.source ? ' from ' + preview.source : ''}.
                      {preview.extracted_text ? ' The text was copied into the box above — fix the lines and try again.' : ' If the PDF is a scan, paste the logins instead.'}
                    </span>
                  </div>
                ) : (
                  <div className={blocked ? 'import-summary bad' : 'import-summary good'}>
                    <span>
                      {preview.logins.length} login(s) read.
                      {preview.duplicates.length > 0 && ' Repeated in the file: ' + preview.duplicates.join(', ') + '.'}
                      {preview.conflicts.length > 0 && ' Already in the pool: ' + preview.conflicts.join(', ') + '.'}
                      {preview.unknown.length > 0 && ' Not found: ' + preview.unknown.join(', ') + '.'}
                      {(preview.ambiguous ?? []).length > 0 && ' ' + (preview.ambiguous ?? []).join(' ') + '.'}
                      {preview.skipped.length > 0 && ' ' + preview.skipped.length + ' line(s) skipped.'}
                    </span>
                  </div>
                )}

                {preview.logins.length > 0 && (
                  <div className="cyber-table-wrap credential-table-wrap">
                    <table className="cyber-table">
                      <thead>
                        <tr><th>LINE</th><th>USERNAME</th><th>PASSWORD</th><th>FOR</th></tr>
                      </thead>
                      <tbody>
                        {preview.logins.map((l, i) => (
                          <tr key={i} className={l.conflict ? 'row-error' : ''}>
                            <td>{l.line}</td>
                            <td>{l.username}</td>
                            <td className="wifi-password">{l.password}</td>
                            <td>{l.team || l.account_id || l.label || <span style={{ color: 'var(--muted)' }}>pool</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {preview.skipped.length > 0 && (
                  <details className="wifi-skipped">
                    <summary>{preview.skipped.length} line(s) skipped</summary>
                    <ul>{preview.skipped.map((s) => <li key={s.line}>line {s.line}: {s.text}</li>)}</ul>
                  </details>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
